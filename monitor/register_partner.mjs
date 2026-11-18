// 테슬라 개발자 앱을 내 도메인(공개키가 올라간 곳)과 연결하는 1회성 등록.
// 실행: node monitor/register_partner.mjs
// 전제: ~/.config/tesla-monitor/config.json 에 client_id, client_secret, domain
//       https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem 이 열려야 함
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = process.env.TESLA_MONITOR_DIR || path.join(os.homedir(), '.config', 'tesla-monitor');
const conf = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const API = 'https://fleet-api.prd.na.vn.cloud.tesla.com';

const keyUrl = `https://${conf.domain}/.well-known/appspecific/com.tesla.3p.public-key.pem`;
const k = await fetch(keyUrl);
if (!k.ok) { console.error(`공개키가 안 열립니다: ${keyUrl} (${k.status})`); process.exit(1); }
console.log(`공개키 확인: ${keyUrl}`);

const tok = await fetch('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials', client_id: conf.client_id, client_secret: conf.client_secret,
    scope: 'openid vehicle_device_data vehicle_location', audience: API,
  }),
}).then((r) => r.json());
if (!tok.access_token) { console.error('파트너 토큰 실패:', tok.error, tok.error_description || ''); process.exit(1); }

const res = await fetch(`${API}/api/1/partner_accounts`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ domain: conf.domain }),
});
const body = await res.json().catch(() => ({}));
console.log(res.ok ? `등록 완료 (${conf.domain})` : `등록 실패 ${res.status}: ${JSON.stringify(body)}`);
process.exit(res.ok ? 0 : 1);
