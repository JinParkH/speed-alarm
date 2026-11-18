#!/bin/zsh
# 테슬라 개발자 앱의 Client ID / Client Secret 을 ~/.config/tesla-monitor/config.json 에 저장 (화면에 시크릿 안 보임)
CONF="${TESLA_MONITOR_DIR:-$HOME/.config/tesla-monitor}/config.json"
print -n "Client ID 붙여넣기: "; read -r CID
print -n "Client Secret 붙여넣기 (입력해도 안 보임): "; read -rs CSEC; print
[[ -z "$CID" || -z "$CSEC" ]] && { print "비어 있어서 저장하지 않았습니다."; exit 1; }
CID="$CID" CSEC="$CSEC" CONF="$CONF" python3 -I - <<'PY'
import json, os
import secrets
p = os.environ["CONF"]
os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True)
if os.path.exists(p):
    c = json.load(open(p))
else:  # 처음이면 기본 설정 + 대시보드 PIN 생성
    c = {"port": 8790, "redirect_uri": "http://localhost:8790/callback", "domain": "jinparkh.github.io",
         "pin": str(secrets.randbelow(900000) + 100000), "monthly_budget_usd": 8,
         "poll": {"list_sec": 120, "driving_sec": 60, "charging_sec": 300, "parked_sec": 900}}
c["client_id"] = os.environ["CID"].strip()
c["client_secret"] = os.environ["CSEC"].strip()
fd = os.open(p + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, json.dumps(c, indent=2).encode()); os.close(fd)
os.replace(p + ".tmp", p)
print(f"저장 완료: client_id {c['client_id'][:6]}… / secret {len(c['client_secret'])}자 / 대시보드 PIN {c['pin']}")
PY
