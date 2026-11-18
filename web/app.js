// 과속알람 — 아이폰 Safari 홈 화면 웹앱
// 폰 GPS 속도 + 전국 무인단속카메라 데이터(앱에 내장)로, 진행 방향 앞 N m 안의 카메라 제한속도를
// 넘으면 감속할 때까지 알람을 계속 울린다. 차량(테슬라) 연동 없이 단독 동작.
'use strict';

const VERSION = '0.1.0';
const $ = (id) => document.getElementById(id);

// ---------- 설정 ----------
const DEFAULTS = { range: 300, tol: 0, chime: true, voice: true, audio: 'playback' };
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('sa_settings') || '{}')); } catch (_) {}
function saveSettings() { try { localStorage.setItem('sa_settings', JSON.stringify(settings)); } catch (_) {} }

// ---------- 지리 계산 (짧은 거리용 평면 근사) ----------
const M_PER_DEG_LAT = 110540;
function delta(lat1, lon1, lat2, lon2) {
  const dx = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  const dy = (lat2 - lat1) * M_PER_DEG_LAT;
  return { dx, dy, d: Math.hypot(dx, dy) };
}
const toRad = (deg) => deg * Math.PI / 180;
const angDiff = (a, b) => { let x = ((a - b) % 360 + 540) % 360 - 180; return x; };

// ---------- 카메라 데이터 + 격자 인덱스 ----------
// 레코드: [lat, lon, limit, flags, sectLenM, label], flags 1=구간시점 2=구간종점 4=보호구역
let cams = [];
const grid = new Map();
const cellKey = (lat, lon) => Math.floor(lat * 100) + ',' + Math.floor(lon * 100);  // 약 1.1km 격자
function indexCams() {
  grid.clear();
  cams.forEach((c, i) => {
    const k = cellKey(c[0], c[1]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
}
function nearby(lat, lon) {
  const r = Math.floor(lat * 100), q = Math.floor(lon * 100), out = [];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const arr = grid.get((r + a) + ',' + (q + b));
    if (arr) out.push(...arr);
  }
  return out;
}

async function loadData() {
  try {
    const res = await fetch('cams.json', { cache: 'no-cache' });
    const d = await res.json();
    cams = d.c || [];
    indexCams();
    setChip('dataChip', `카메라 ${cams.length.toLocaleString()}개${d.src === '샘플' ? ' (샘플)' : ''}`, d.src === '샘플' ? 'warn' : 'ok');
    $('dataInfo').textContent = `${d.src} · ${d.n.toLocaleString()}개 · 변환일 ${d.v}`;
  } catch (e) {
    setChip('dataChip', '데이터 없음', 'bad');
  }
}

// ---------- 소리 ----------
let actx = null;
function setAudioSession() {
  try { if (navigator.audioSession) navigator.audioSession.type = settings.audio; } catch (_) {}
}
function unlockAudio() {
  setAudioSession();
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state !== 'running') actx.resume();
  // iOS: 사용자 탭 안에서 한 번 소리를 내야 이후 재생 가능
  const b = actx.createBuffer(1, 1, 22050), s = actx.createBufferSource();
  s.buffer = b; s.connect(actx.destination); s.start(0);
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u);
  }
}
function tone(freq, dur, vol = 0.9, at = 0) {
  if (!actx) return;
  const t = actx.currentTime + at, o = actx.createOscillator(), g = actx.createGain();
  o.type = 'square'; o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol * 0.35, t + 0.01);
  g.gain.setValueAtTime(vol * 0.35, t + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
}
function chime() { tone(880, 0.18, 0.6); tone(660, 0.28, 0.6, 0.2); }
function alarmBeep(over) {
  const f = over >= 20 ? 2000 : over >= 10 ? 1700 : 1400;
  tone(f, 0.11); tone(f, 0.11, 0.9, 0.16);
}
let lastSpeech = '';
function say(text) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR'; u.rate = 1.1; u.volume = 1;
  speechSynthesis.speak(u); lastSpeech = text;
}

// ---------- 화면 꺼짐 방지 ----------
let wakeLock = null;
async function requestWake() {
  if (!('wakeLock' in navigator)) { setChip('wakeChip', '화면유지 미지원', 'bad'); return; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    setChip('wakeChip', '화면유지 켜짐', 'ok');
    wakeLock.addEventListener('release', () => { if (running) setChip('wakeChip', '화면유지 풀림', 'warn'); });
  } catch (e) { setChip('wakeChip', '화면유지 실패', 'bad'); }
}

// ---------- 상태 ----------
let running = false, watchId = null, simTimer = null;
let last = null;            // 직전 위치 {lat, lon, t}
let heading = null;         // 진행 방향(도, 북=0)
let speedKmh = null;
let lastFixAt = 0;
let odo = 0;                // 누적 이동거리(m)
let target = null;          // {i, along, dist}
const passed = new Map();   // 지나친 카메라 i → 시각 (2분간 재감지 안 함)
let section = null;         // 구간단속 중 {limit, startOdo, startT, len, label}
let announced = -1;         // 진입 안내를 이미 한 카메라 i
let alarmOn = false, nextBeepAt = 0;

function setChip(id, text, cls) { const el = $(id); el.textContent = text; el.className = 'chip' + (cls ? ' ' + cls : ''); }

// ---------- 위치 처리 (실제 GPS와 모의주행이 같은 경로 사용) ----------
function onFix(lat, lon, spdMs, hdg, acc, t) {
  lastFixAt = Date.now();
  // 속도: GPS가 주는 값 우선, 없으면 직전 위치로 계산
  let d = null;
  if (last) d = delta(last.lat, last.lon, lat, lon);
  if (spdMs != null && spdMs >= 0) speedKmh = spdMs * 3.6;
  else if (d && t > last.t) speedKmh = (d.d / ((t - last.t) / 1000)) * 3.6;
  // 방향: 움직이는 중의 GPS heading 우선, 아니면 이동 벡터
  if (hdg != null && !isNaN(hdg) && (spdMs == null || spdMs > 1.5)) heading = hdg;
  else if (d && d.d > 8) heading = (Math.atan2(d.dx, d.dy) * 180 / Math.PI + 360) % 360;
  if (d && (acc == null || acc < 50) && d.d < 200) odo += d.d;
  if (!last || !d || d.d > 3 || t - last.t > 3000) last = { lat, lon, t };

  setChip('gpsChip', acc != null ? `GPS ±${Math.round(acc)}m` : 'GPS', acc != null && acc > 30 ? 'warn' : 'ok');
  updateTarget(lat, lon);
  updateSection();
  render();
}

function updateTarget(lat, lon) {
  const now = Date.now();
  for (const [i, ts] of passed) if (now - ts > 120000) passed.delete(i);
  if (heading == null) { target = null; return; }
  const range = settings.range;
  let best = null;
  for (const i of nearby(lat, lon)) {
    if (passed.has(i)) continue;
    const c = cams[i], v = delta(lat, lon, c[0], c[1]);
    if (v.d > range + 60) continue;
    const brg = Math.atan2(v.dx, v.dy) * 180 / Math.PI;
    const diff = toRad(angDiff(brg, heading));
    const along = v.d * Math.cos(diff), lateral = Math.abs(v.d * Math.sin(diff));
    // 진행 방향 앞쪽, 도로 폭 안쪽(옆 도로·반대편 골목 제외)
    if (along < -15 || along > range || lateral > 45) continue;
    if (!best || along < best.along) best = { i, along, dist: v.d };
  }
  // 이전 타깃을 지나쳤는지 판정
  if (target && (!best || best.i !== target.i)) {
    const c = cams[target.i], v = delta(lat, lon, c[0], c[1]);
    const brg = Math.atan2(v.dx, v.dy) * 180 / Math.PI;
    const along = v.d * Math.cos(toRad(angDiff(brg, heading)));
    if (along < -15 || v.d > range + 100) {
      passed.set(target.i, now);
      if (along < -15) onPassed(target.i);
    }
  }
  target = best;
  if (target && announced !== target.i) {
    announced = target.i;
    const c = cams[target.i];
    if (settings.chime) chime();
    const kind = c[3] & 1 ? '구간단속 시작' : c[3] & 2 ? '구간단속 끝' : c[3] & 4 ? '보호구역 단속' : '과속 단속';
    setTimeout(() => say(`${Math.round(target ? target.along / 50 : 0) * 50}미터 앞 ${kind}, 제한속도 ${c[2]}`), 450);
  }
}

function onPassed(i) {
  const c = cams[i];
  if (c[3] & 1) {
    section = { limit: c[2], startOdo: odo, startT: Date.now(), len: c[4] || 0, label: c[5] };
  } else if (c[3] & 2 && section) {
    endSection();
  }
}
function updateSection() {
  if (!section) return;
  const done = odo - section.startOdo;
  const maxLen = section.len ? section.len + 150 : 20000;
  if (done > maxLen) endSection();
}
function endSection() {
  if (!section) return;
  const avg = sectionAvg();
  section = null;
  if (avg != null) say(`구간단속 종료. 평균 ${Math.round(avg)}킬로`);
}
function sectionAvg() {
  if (!section) return null;
  const sec = (Date.now() - section.startT) / 1000;
  return sec > 3 ? ((odo - section.startOdo) / sec) * 3.6 : null;
}

// ---------- 알람 판단 + 화면 ----------
function activeLimit() {
  if (target) return cams[target.i][2];
  if (section) return section.limit;
  return null;
}
function render() {
  $('speed').textContent = speedKmh == null ? '--' : Math.round(speedKmh);
  const limit = activeLimit();
  const sign = $('sign'), tags = [];
  if (target) {
    const c = cams[target.i];
    sign.textContent = c[2]; sign.className = 'sign';
    $('dist').textContent = `${Math.max(0, Math.round(target.along))} m`;
    $('label').textContent = c[5] || '무인단속카메라';
    if (c[3] & 1) tags.push('구간단속 시점'); if (c[3] & 2) tags.push('구간단속 종점'); if (c[3] & 4) tags.push('보호구역');
  } else if (section) {
    sign.textContent = section.limit; sign.className = 'sign';
    const left = section.len ? Math.max(0, section.len - (odo - section.startOdo)) : null;
    $('dist').textContent = left != null ? `구간 남은 ${(left / 1000).toFixed(1)} km` : '구간단속 중';
    $('label').textContent = section.label || '';
  } else {
    sign.textContent = '--'; sign.className = 'sign off';
    $('dist').textContent = running ? '전방 카메라 없음' : '대기 중';
    $('label').innerHTML = '&nbsp;';
  }
  const avg = sectionAvg();
  $('avgText').textContent = avg != null ? ` · 구간평균 ${Math.round(avg)}` : '';
  $('tags').innerHTML = tags.map((t) => `<span class="tag">${t}</span>`).join(' ');

  alarmOn = running && limit != null && speedKmh != null && speedKmh > limit + settings.tol;
  document.body.classList.toggle('alarm', alarmOn);
  document.body.classList.toggle('near', !!target);
}

// 알람 루프: 조건이 유지되는 동안 계속 울린다. 가까울수록 빠르게.
setInterval(() => {
  // GPS가 끊기면 알림
  if (running && !simTimer && lastFixAt && Date.now() - lastFixAt > 6000) {
    setChip('gpsChip', 'GPS 끊김', 'bad');
  }
  if (!alarmOn) return;
  const now = performance.now();
  if (now < nextBeepAt) return;
  const limit = activeLimit();
  const over = speedKmh - limit;
  alarmBeep(over);
  const dist = target ? Math.max(0, target.along) : 150;
  nextBeepAt = now + 300 + (dist / settings.range) * 700;  // 0m: 0.3초, 끝거리: 1초 간격
}, 50);

// ---------- 시작/정지 ----------
function start() {
  unlockAudio();
  requestWake();
  running = true;
  $('startBtn').textContent = '정지'; $('startBtn').classList.add('running');
  if (simTimer) return render();
  if (!('geolocation' in navigator)) { $('notice').textContent = '이 브라우저는 위치를 지원하지 않습니다'; return; }
  watchId = navigator.geolocation.watchPosition(
    (p) => onFix(p.coords.latitude, p.coords.longitude, p.coords.speed, p.coords.heading, p.coords.accuracy, p.timestamp),
    (e) => {
      setChip('gpsChip', e.code === 1 ? '위치 권한 거부됨' : 'GPS 오류', 'bad');
      if (e.code === 1) $('notice').textContent = '설정 > 개인정보 보호 > 위치 서비스 > Safari 웹 사이트에서 허용해 주세요';
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
  render();
}
function stop() {
  running = false;
  if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null;
  stopSim();
  if (wakeLock) wakeLock.release().catch(() => {}); wakeLock = null;
  setChip('wakeChip', '화면유지 꺼짐');
  $('startBtn').textContent = '시작'; $('startBtn').classList.remove('running');
  target = null; section = null; alarmOn = false; render();
}
$('startBtn').onclick = () => (running ? stop() : start());

// 백그라운드 → 복귀 시 화면유지·소리 다시 잡기 (iOS는 백그라운드에서 웹앱 GPS가 멈춤)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) {
    requestWake();
    if (actx && actx.state !== 'running') actx.resume();
    $('notice').textContent = '';
  } else if (running) {
    $('notice').textContent = '앱이 화면에 있어야 동작합니다';
  }
});

// ---------- 모의주행 ----------
let sim = null;
function startSim() {
  if (!cams.length) return;
  const c = cams[0];
  // 첫 카메라 1km 남쪽에서 북쪽으로 출발
  sim = { lat: c[0] - 1000 / M_PER_DEG_LAT, lon: c[1], hdg: 0, kmh: Number($('simSpeed').textContent) };
  document.body.classList.add('simming');
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  last = null; heading = null; odo = 0; passed.clear(); section = null; announced = -1;
  simTimer = setInterval(() => {
    const step = sim.kmh / 3.6;  // 1초 이동거리
    sim.lat += (step * Math.cos(toRad(sim.hdg))) / M_PER_DEG_LAT;
    sim.lon += (step * Math.sin(toRad(sim.hdg))) / (111320 * Math.cos(toRad(sim.lat)));
    onFix(sim.lat, sim.lon, sim.kmh / 3.6, sim.hdg, 5, Date.now());
  }, 1000);
  if (!running) start();
  $('simBtn').textContent = '중지';
}
function stopSim() {
  if (simTimer) clearInterval(simTimer);
  simTimer = null; sim = null;
  document.body.classList.remove('simming');
  $('simBtn').textContent = '시작';
}
$('simBtn').onclick = () => { closeSheet(); if (simTimer) { stopSim(); stop(); } else { unlockAudio(); startSim(); } };
$('simUp').onclick = () => { const v = Math.min(200, Number($('simSpeed').textContent) + 10); $('simSpeed').textContent = v; if (sim) sim.kmh = v; };
$('simDown').onclick = () => { const v = Math.max(0, Number($('simSpeed').textContent) - 10); $('simSpeed').textContent = v; if (sim) sim.kmh = v; };

// ---------- 설정 시트 ----------
function openSheet() {
  $('s_range').value = settings.range; $('s_tol').value = settings.tol;
  $('s_chime').checked = settings.chime; $('s_voice').checked = settings.voice; $('s_audio').value = settings.audio;
  $('sheet').classList.add('open');
}
function closeSheet() { $('sheet').classList.remove('open'); }
$('setBtn').onclick = openSheet;
$('closeBtn').onclick = closeSheet;
$('sheet').onclick = (e) => { if (e.target.id === 'sheet') closeSheet(); };
$('s_range').onchange = (e) => { settings.range = Math.min(1000, Math.max(100, Number(e.target.value) || 300)); saveSettings(); };
$('s_tol').onchange = (e) => { settings.tol = Math.min(20, Math.max(0, Number(e.target.value) || 0)); saveSettings(); };
$('s_chime').onchange = (e) => { settings.chime = e.target.checked; saveSettings(); };
$('s_voice').onchange = (e) => { settings.voice = e.target.checked; saveSettings(); };
$('s_audio').onchange = (e) => { settings.audio = e.target.value; saveSettings(); setAudioSession(); };
$('testBtn').onclick = () => { unlockAudio(); alarmBeep(5); setTimeout(() => alarmBeep(15), 400); setTimeout(() => alarmBeep(25), 800); setTimeout(() => say('알람 테스트입니다'), 1300); };
$('verInfo').textContent = VERSION;

// ---------- 오프라인 캐시 ----------
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

loadData().then(render);

// 테스트용 노출
window.__sa = { onFix, settings, get state() { return { speedKmh, heading, target, section, alarmOn, odo, passed: [...passed.keys()] }; } };
