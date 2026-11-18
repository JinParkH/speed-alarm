# 맥미니에 차량 모니터 설치하기

맥미니(24시간 켜 둠)에서 서버를 돌린다. 맥미니의 Claude Code에 이렇게 말하면 된다:
**"~/Desktop/tesla-speed-alarm/monitor/MACMINI.md 대로 설치해줘"**

이미 끝난 것 (맥북에서, 2026-11-18)
- 테슬라 개발자 앱 "JH Personal Vehicle Monitor" 등록·활성화
  (출처 `https://jinparkh.github.io`, 리디렉션 `http://localhost:8790/callback`, 범위: 차량 정보·위치·명령·충전 관리)
- 공개키 게시: https://jinparkh.github.io/.well-known/appspecific/com.tesla.3p.public-key.pem
  (짝이 되는 개인키는 맥북 `~/.config/tesla-monitor/private-key.pem` — 지금 기능(읽기)에는 필요 없음, 원격 명령을 붙일 때 맥미니로 복사)

## 순서
1. 코드 받기
   ```bash
   cd ~/Desktop && git clone https://github.com/JinParkH/speed-alarm.git tesla-speed-alarm
   ```
   (이미 있으면 `cd ~/Desktop/tesla-speed-alarm && git pull`)
2. Node 확인: `node -v` 가 v22 이상 (없으면 `brew install node`)
3. Client ID/Secret 입력 (사용자가 맥미니 터미널에 직접 붙여넣기, Secret은 화면에 안 보임. 설정 파일·PIN도 이때 생성)
   ```bash
   cd ~/Desktop/tesla-speed-alarm && ./monitor/set_credentials.sh
   ```
   Client ID/Secret은 developer.tesla.com → 앱 "세부내역 확인"에 있음
4. 테슬라에 도메인 등록 (1회): `node monitor/register_partner.mjs` → "등록 완료"
5. 자동 실행 등록: `./monitor/install_launchd.sh` (포트 8790. 8787은 claude-notify 브리지가 사용 중이니 겹치지 않음)
6. **맥미니의 브라우저**에서 `http://localhost:8790` → PIN 입력(`~/.config/tesla-monitor/config.json` 의 `pin`)
   → 배너의 "테슬라로 로그인" → 테슬라 계정 로그인·동의 → 대시보드에 차 정보가 나오면 성공
   (차가 잠들어 있으면 "잠듦"만 나옴. "차 깨우기"를 한 번 누르거나 차를 쓰고 나면 채워짐)
7. 휴대폰: 집 와이파이에서 `http://192.168.0.200:8790` (맥미니 IP가 바뀌었으면 `ipconfig getifaddr en0`)
   → Safari 공유 → 홈 화면에 추가

## 밖에서도 보려면 (선택)
맥미니와 아이폰에 Tailscale 설치 → 같은 계정으로 로그인 → 아이폰에서 `http://<맥미니 Tailscale 이름>:8790`.
공유기 포트포워딩으로 인터넷에 직접 열지는 말 것.

## 문제 해결
- 로그: `tail -f ~/.config/tesla-monitor/server.log`
- 재시작: `launchctl kickstart -k gui/$(id -u)/com.jhpark.tesla-monitor`
- 등록 실패 "client_id was not provided": 3번 설정이 안 된 것
- 로그인 후 "redirect_uri mismatch": 테슬라 앱의 리디렉션 URI가 `http://localhost:8790/callback` 과 정확히 같은지 확인
