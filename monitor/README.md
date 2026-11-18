# 테슬라 차량 상태 모니터 (개인용)

Mac에서 도는 작은 서버가 테슬라 공식 Fleet API로 차 상태를 읽어 저장하고, 폰에서 볼 대시보드를 제공한다.
24시간 켜 두는 **맥미니**에서 운영하는 것을 전제로 한다. 외부 패키지 없음(Node 22). **맥미니 설치 순서: [MACMINI.md](MACMINI.md)**

- 보여주는 것: 배터리 %·주행가능거리·충전 상태(속도·남은 시간)·24시간 배터리 그래프, 잠금·감시 모드, 문·창문·트렁크 열림,
  실내외 온도·공조, 타이어 공기압(psi, 낮은 바퀴 경고), 위치(카카오맵), 주행거리, 소프트웨어 버전
- 조회 규칙: 2분마다 차량 목록으로 깨어 있는지만 확인 → **깨어 있을 때만** 상세 조회(주행 중 1분, 충전 중 5분, 주차 15분).
  잠든 차는 자동으로 깨우지 않는다(깨우기 버튼은 수동). 이번 달 비용을 집계해 `monthly_budget_usd`(기본 $8)를 넘으면 자동 조회를 멈춘다.
- 비밀값은 저장소 밖에만: `~/.config/tesla-monitor/` — `config.json`(client_id/secret, 대시보드 PIN), `tokens.json`, `private-key.pem`, `history.jsonl`

## 테슬라 등록 (1회, 사용자가 직접)
1. **공개키 도메인**: `https://jinparkh.github.io/.well-known/appspecific/com.tesla.3p.public-key.pem` 이 열려야 한다
   (GitHub `JinParkH/jinparkh.github.io` 저장소, 공개키만 들어 있음). 개인키는 `~/.config/tesla-monitor/private-key.pem`.
2. https://developer.tesla.com 에 테슬라 계정으로 로그인 → **앱 만들기(Request app access)**
   - 앱 이름/설명: 아무거나 (예: "개인용 차량 모니터")
   - Allowed Origin(s): `https://jinparkh.github.io`
   - Allowed Redirect URI(s): `http://localhost:8790/callback`
   - Scopes: **Vehicle Information**, **Vehicle Location** (나중에 원격 명령을 쓰려면 Vehicle Commands, Charging Commands도)
   - 결제 수단 등록이 요구될 수 있음(월 $10 할인 안에서는 청구 없음)
3. 승인되면 나오는 **Client ID / Client Secret**을 `~/.config/tesla-monitor/config.json` 의 `client_id`, `client_secret`에 넣는다.
4. 도메인 등록: `node monitor/register_partner.mjs` → "등록 완료"가 나오면 됨
5. 서버 실행 후, **서버가 도는 Mac의 브라우저**에서 `http://localhost:8790/login` → 테슬라 로그인·동의 → 대시보드로 돌아오면 끝

## 실행
```bash
cd ~/Desktop/tesla-speed-alarm
node monitor/server.mjs              # 실제
MOCK=1 node monitor/server.mjs       # 가짜 데이터로 화면만 확인
```
대시보드 PIN: `~/.config/tesla-monitor/config.json` 의 `pin`.

## 폰에서 보기
- 집 와이파이: `http://<맥미니 IP>:8790` (예: http://192.168.0.200:8790)
- 밖(차 안): 맥미니와 아이폰에 **Tailscale**을 설치하면 어디서든 `http://<맥미니 Tailscale 이름>:8790` 로 접속. 포트를 인터넷에 직접 열지 말 것.

## 나중에
- 원격 명령(문 잠금, 공조 켜기 등): 차량에 가상 키 등록(`https://tesla.com/_ak/jinparkh.github.io`) + 명령 서명(tesla-http-proxy) 필요
- 실시간 스트리밍(Fleet Telemetry): 더 싸고 빠르지만 공인 TLS 서버가 필요
