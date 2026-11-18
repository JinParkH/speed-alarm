// 테슬라 차량 상태 모니터 — 개인용 (Node 22, 외부 패키지 없음)
// Fleet API(공식)로 차량 상태를 주기적으로 읽어 저장하고, 폰에서 볼 대시보드를 제공한다.
// 비밀값(클라이언트 시크릿, 토큰, 개인키)은 저장소 밖 ~/.config/tesla-monitor/ 에만 둔다.
//
// 실행:  node monitor/server.mjs            (실제)
//        MOCK=1 node monitor/server.mjs     (가짜 차량 데이터로 화면 확인)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONF_DIR = process.env.TESLA_MONITOR_DIR || path.join(os.homedir(), '.config', 'tesla-monitor');
const CONF_FILE = path.join(CONF_DIR, 'config.json');
const TOKEN_FILE = path.join(CONF_DIR, 'tokens.json');
const HIST_FILE = path.join(CONF_DIR, 'history.jsonl');
const USAGE_FILE = path.join(CONF_DIR, 'usage.json');
const MOCK = process.env.MOCK === '1';

// 한국은 북미·아시아태평양 리전
const AUTH_URL = 'https://auth.tesla.com/oauth2/v3/authorize';
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const API = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const SCOPES = 'openid offline_access vehicle_device_data vehicle_location';

// 요금(USD) — Tesla 공개 단가. 월 $10 할인 안에서 쓰도록 상한을 둔다.
const PRICE = { data: 0.002, wake: 0.02, command: 0.001 };

const DEFAULT_CONF = {
  port: 8790,
  client_id: '',
  client_secret: '',
  redirect_uri: 'http://localhost:8790/callback',
  domain: 'jinparkh.github.io',
  pin: '',                  // 대시보드 접속 PIN (비우면 첫 실행 때 자동 생성)
  monthly_budget_usd: 8,    // 자동 조회가 이 금액을 넘으면 멈춤 (수동 새로고침은 가능)
  poll: { list_sec: 120, driving_sec: 60, charging_sec: 300, parked_sec: 900 },
};

fs.mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 });

let conf = { ...DEFAULT_CONF, ...readJson(CONF_FILE, {}) };
conf.poll = { ...DEFAULT_CONF.poll, ...(conf.poll || {}) };
if (!conf.pin) conf.pin = String(crypto.randomInt(100000, 999999));
if (!fs.existsSync(CONF_FILE) || !readJson(CONF_FILE, {}).pin) writeJson(CONF_FILE, conf);

let tokens = readJson(TOKEN_FILE, null);
const configured = () => MOCK || (conf.client_id && conf.client_secret);
const loggedIn = () => MOCK || !!(tokens && tokens.refresh_token);

// ---------- 사용량(비용) 집계 ----------
const monthKey = () => new Date().toISOString().slice(0, 7);
let usage = readJson(USAGE_FILE, {});
function addUsage(kind) {
  const m = monthKey();
  usage[m] = usage[m] || { data: 0, wake: 0, command: 0 };
  usage[m][kind]++;
  writeJson(USAGE_FILE, usage);
}
function monthCost() {
  const u = usage[monthKey()] || { data: 0, wake: 0, command: 0 };
  return { ...u, usd: +(u.data * PRICE.data + u.wake * PRICE.wake + u.command * PRICE.command).toFixed(3) };
}
const overBudget = () => monthCost().usd >= conf.monthly_budget_usd;

// ---------- OAuth ----------
const pendingStates = new Set();
function authorizeUrl() {
  const state = crypto.randomBytes(12).toString('hex');
  pendingStates.add(state);
  const q = new URLSearchParams({
    response_type: 'code', client_id: conf.client_id, redirect_uri: conf.redirect_uri,
    scope: SCOPES, state, locale: 'ko-KR', prompt_missing_scopes: 'true',
  });
  return `${AUTH_URL}?${q}`;
}
async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: conf.client_id, client_secret: conf.client_secret, audience: API, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`토큰 요청 실패 ${res.status}: ${body.error || ''} ${body.error_description || ''}`);
  return body;
}
function saveTokens(t) {
  tokens = { ...tokens, ...t, expires_at: Date.now() + (t.expires_in || 28800) * 1000 };
  writeJson(TOKEN_FILE, tokens);
}
async function accessToken() {
  if (!tokens) throw new Error('로그인 필요');
  if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
    saveTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }));
  }
  return tokens.access_token;
}

// ---------- Fleet API ----------
async function api(method, p, kind) {
  const res = await fetch(API + p, { method, headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (kind) addUsage(kind);
  const body = await res.json().catch(() => ({}));
  if (res.status === 408) return { asleep: true };       // 차가 잠들어 있음 (깨우지 않음)
  if (!res.ok) throw new Error(`${p} → ${res.status} ${body.error || ''}`);
  return body.response;
}
const DATA_ENDPOINTS = 'charge_state;climate_state;drive_state;location_data;vehicle_state;vehicle_config';

// ---------- 상태 정규화 ----------
const MI = 1.609344;
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
function normalize(v) {
  const c = v.charge_state || {}, cl = v.climate_state || {}, d = v.drive_state || {}, s = v.vehicle_state || {}, cfg = v.vehicle_config || {};
  const open = (x) => !!x && x !== 0;
  return {
    t: Date.now(),
    name: v.display_name || s.vehicle_name || '내 테슬라',
    model: cfg.car_type || null,
    state: v.state || 'online',
    battery: c.battery_level ?? null,
    usable_battery: c.usable_battery_level ?? null,
    range_km: c.battery_range != null ? Math.round(c.battery_range * MI) : null,
    charging: c.charging_state || null,               // Charging / Complete / Disconnected / Stopped
    charge_limit: c.charge_limit_soc ?? null,
    charge_kw: c.charger_power ?? null,
    minutes_to_full: c.minutes_to_full_charge ?? null,
    plugged: c.charge_port_door_open && c.charging_state !== 'Disconnected',
    locked: s.locked ?? null,
    sentry: s.sentry_mode ?? null,
    doors: { fl: open(s.df), rl: open(s.dr), fr: open(s.pf), rr: open(s.pr) },
    trunk: { front: open(s.ft), rear: open(s.rt) },
    windows: { fl: open(s.fd_window), fr: open(s.fp_window), rl: open(s.rd_window), rr: open(s.rp_window) },
    user_present: s.is_user_present ?? null,
    odometer_km: s.odometer != null ? Math.round(s.odometer * MI) : null,
    version: (s.car_version || '').split(' ')[0] || null,
    update_available: !!(s.software_update && s.software_update.status && s.software_update.status !== ''),
    tpms_bar: { fl: r1(s.tpms_pressure_fl), fr: r1(s.tpms_pressure_fr), rl: r1(s.tpms_pressure_rl), rr: r1(s.tpms_pressure_rr) },
    inside_c: cl.inside_temp ?? null,
    outside_c: cl.outside_temp ?? null,
    climate_on: cl.is_climate_on ?? null,
    lat: d.latitude ?? null, lon: d.longitude ?? null, heading: d.heading ?? null,
    speed_kmh: d.speed != null ? Math.round(d.speed * MI) : null,
    shift: d.shift_state || 'P',
  };
}

// ---------- 가짜 차량 (MOCK) ----------
let mockT0 = Date.now();
function mockVehicle() {
  const min = (Date.now() - mockT0) / 60000;
  return {
    display_name: '내 모델 Y', state: 'online',
    charge_state: { battery_level: Math.max(20, 78 - Math.floor(min)), usable_battery_level: 77, battery_range: 260 - min, charging_state: 'Disconnected', charge_limit_soc: 80, charger_power: 0, minutes_to_full_charge: 0 },
    climate_state: { inside_temp: 21.5, outside_temp: 6.0, is_climate_on: false },
    drive_state: { latitude: 37.5663, longitude: 126.9779, heading: 10, speed: null, shift_state: null },
    vehicle_state: { locked: true, sentry_mode: true, df: 0, dr: 0, pf: 0, pr: 0, ft: 0, rt: 0, fd_window: 0, fp_window: 0, rd_window: 1, rp_window: 0,
      odometer: 9321.4, car_version: '2026.38.4 abc', tpms_pressure_fl: 2.9, tpms_pressure_fr: 2.9, tpms_pressure_rl: 2.6, tpms_pressure_rr: 2.9, is_user_present: false },
    vehicle_config: { car_type: 'modely' },
  };
}

// ---------- 폴링 ----------
const status = { vehicles: [], snapshot: null, lastPoll: null, nextPoll: null, error: null, asleep: false, vin: null, id: null };

async function pollOnce({ manual = false } = {}) {
  status.error = null;
  try {
    if (MOCK) {
      status.vehicles = [{ id: 1, display_name: '내 모델 Y', state: 'online' }];
      status.asleep = false;
      record(normalize(mockVehicle()));
      return;
    }
    // 1) 목록으로 상태만 확인 (깨우지 않음)
    const list = await api('GET', '/api/1/vehicles');
    status.vehicles = (list || []).map((v) => ({ id: v.id, vin: v.vin, display_name: v.display_name, state: v.state }));
    const v = status.vehicles[0];
    if (!v) { status.error = '계정에 차량이 없습니다'; return; }
    status.vin = v.vin; status.id = v.id;
    status.asleep = v.state !== 'online';
    if (status.asleep) return;
    // 2) 깨어 있을 때만 상세 조회 (상태별 간격, 예산 상한)
    const due = manual || !status.snapshot || Date.now() - status.snapshot.t >= detailInterval() * 1000;
    if (!due) return;
    if (!manual && overBudget()) { status.error = `이번 달 자동 조회 예산($${conf.monthly_budget_usd}) 도달 — 수동 새로고침만 가능`; return; }
    const data = await api('GET', `/api/1/vehicles/${v.vin}/vehicle_data?endpoints=${encodeURIComponent(DATA_ENDPOINTS)}`, 'data');
    if (data && data.asleep) { status.asleep = true; return; }
    record(normalize(data));
  } catch (e) {
    status.error = e.message;
  } finally {
    status.lastPoll = Date.now();
  }
}
function detailInterval() {
  const s = status.snapshot;
  if (!s) return 0;
  if (s.shift && s.shift !== 'P') return conf.poll.driving_sec;
  if (s.charging === 'Charging') return conf.poll.charging_sec;
  return conf.poll.parked_sec;
}
function record(snap) {
  status.snapshot = snap;
  fs.appendFileSync(HIST_FILE, JSON.stringify({ t: snap.t, b: snap.battery, r: snap.range_km, c: snap.charging, s: snap.shift, lat: snap.lat, lon: snap.lon, o: snap.odometer_km }) + '\n', { mode: 0o600 });
}
function history(hours) {
  const since = Date.now() - hours * 3600 * 1000;
  try {
    return fs.readFileSync(HIST_FILE, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && x.t >= since);
  } catch { return []; }
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  if (!configured() || !loggedIn()) return;
  const sec = status.asleep || !status.snapshot ? conf.poll.list_sec : Math.min(conf.poll.list_sec, detailInterval());
  status.nextPoll = Date.now() + sec * 1000;
  timer = setTimeout(async () => { await pollOnce(); schedule(); }, sec * 1000);
}

async function wake() {
  if (MOCK) return pollOnce({ manual: true });
  await api('POST', `/api/1/vehicles/${status.vin}/wake_up`, 'wake');
  for (let i = 0; i < 12; i++) {           // 최대 1분 대기
    await new Promise((r) => setTimeout(r, 5000));
    await pollOnce({ manual: true });
    if (!status.asleep && status.snapshot && Date.now() - status.snapshot.t < 10000) return;
  }
}

// ---------- HTTP ----------
const COOKIE = 'tm_auth';
const authCookie = () => crypto.createHash('sha256').update('tm:' + conf.pin).digest('hex').slice(0, 32);
function isAuthed(req) {
  const c = req.headers.cookie || '';
  return c.split(';').some((p) => p.trim() === `${COOKIE}=${authCookie()}`);
}
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const PUBLIC = path.join(HERE, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // PIN 로그인
    if (p === '/pin' && req.method === 'POST') {
      let body = ''; for await (const ch of req) body += ch;
      const pin = new URLSearchParams(body).get('pin');
      if (pin && crypto.timingSafeEqual(Buffer.from(pin.padEnd(16)), Buffer.from(conf.pin.padEnd(16)))) {
        return send(res, 302, '', 'text/plain', { 'Set-Cookie': `${COOKIE}=${authCookie()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`, Location: '/' });
      }
      return send(res, 302, '', 'text/plain', { Location: '/?bad=1' });
    }
    // 테슬라 OAuth 콜백 (state로 보호)
    if (p === '/callback') {
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      if (!code || !pendingStates.has(state)) return send(res, 400, '잘못된 로그인 응답입니다. 다시 시도하세요.', 'text/plain; charset=utf-8');
      pendingStates.delete(state);
      saveTokens(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: conf.redirect_uri }));
      await pollOnce({ manual: true }); schedule();
      return send(res, 302, '', 'text/plain', { Location: '/' });
    }
    if (!isAuthed(req)) {
      if (p.startsWith('/api/')) return send(res, 401, { error: 'pin' });
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'pin.html')), TYPES['.html']);
    }
    if (p === '/login') {
      if (!configured()) return send(res, 400, 'config.json에 client_id/client_secret을 먼저 넣어주세요.', 'text/plain; charset=utf-8');
      return send(res, 302, '', 'text/plain', { Location: authorizeUrl() });
    }
    if (p === '/api/status') {
      return send(res, 200, {
        mock: MOCK, configured: !!configured(), loggedIn: loggedIn(), asleep: status.asleep, error: status.error,
        snapshot: status.snapshot, lastPoll: status.lastPoll, nextPoll: status.nextPoll,
        vehicle: status.vehicles[0] || null, cost: monthCost(), budget: conf.monthly_budget_usd,
      });
    }
    if (p === '/api/history') return send(res, 200, history(Math.min(168, Number(url.searchParams.get('hours')) || 24)));
    if (p === '/api/refresh' && req.method === 'POST') { await pollOnce({ manual: true }); schedule(); return send(res, 200, { ok: true }); }
    if (p === '/api/wake' && req.method === 'POST') { await wake(); schedule(); return send(res, 200, { ok: true }); }
    // 정적 파일
    const f = path.join(PUBLIC, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (f.startsWith(PUBLIC) && fs.existsSync(f) && fs.statSync(f).isFile()) return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)] || 'application/octet-stream');
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(conf.port, () => {
  console.log(`테슬라 모니터: http://localhost:${conf.port}  (PIN은 ${CONF_FILE} 의 pin)${MOCK ? '  [MOCK]' : ''}`);
  if (!configured()) console.log(`→ ${CONF_FILE} 에 client_id / client_secret 을 넣고 재시작하세요.`);
  else if (!loggedIn()) console.log(`→ 브라우저에서 http://localhost:${conf.port}/login 으로 테슬라 로그인`);
  if (configured() && loggedIn()) pollOnce().then(schedule);
});
