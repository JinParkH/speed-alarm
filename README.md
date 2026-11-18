# 과속알람 (개인용)

아이폰 홈 화면 웹앱. 폰 GPS 속도와 전국 무인단속카메라 데이터(앱에 내장)를 비교해, 진행 방향 앞 300m(설정 가능) 안 카메라의 제한속도를 넘으면 감속할 때까지 알람을 계속 울린다. 차량 연동 없이 단독 동작.

- 주소: https://jinparkh.github.io/speed-alarm/
- 저장소: https://github.com/JinParkH/speed-alarm (public, `web/`이 main 푸시 시 자동 배포)

## 아이폰 설치
1. Safari로 위 주소 열기 → 공유 → **홈 화면에 추가**
2. 홈 화면 아이콘으로 실행 → **시작** → 위치 권한 "앱을 사용하는 동안 허용"
3. 설정 → **알람 소리 테스트**로 소리 확인 (무음 스위치 상태와 블루투스 연결 상태로 각각)

## 동작 조건 (웹앱 한계)
- **화면이 켜진 상태로 앱이 앞에 있어야** GPS가 동작한다. 거치대에 두고 사용. 화면유지(Wake Lock)는 자동 요청.
- 다른 앱으로 전환하거나 잠그면 iOS가 웹앱을 멈춘다 → 이 제약을 없애려면 네이티브(Capacitor) 앱으로 전환 필요.
- 방향 판정: GPS 진행방향 기준 앞쪽 + 좌우 45m 이내 카메라만. 데이터에 카메라 촬영 방향이 없어서 반대 차로 카메라도 잡힐 수 있음(과속 중일 때만 울림).

## 카메라 데이터 갱신
공공데이터포털 「전국무인교통단속카메라표준데이터」(15028200) 오픈API **활용신청**이 먼저 필요(자동승인).

```bash
cd ~/Desktop/tesla-speed-alarm
export $(grep '^DATA_GO_KR_KEY=' ~/Desktop/동남권해커톤/energy-twin-proto/.env.public | xargs)
python3 -I scripts/fetch_cameras.py          # data_raw/cameras_raw.json (git 제외)
python3 -I scripts/build_cams.py data_raw/cameras_raw.json   # web/cams.json
git add web/cams.json && git commit -m "카메라 데이터 갱신" && git push
```

포털에서 CSV를 직접 받았으면 `build_cams.py <csv경로>`도 된다. 샘플로 되돌리기: `build_cams.py --sample`.

## 로컬 테스트
설정 → 모의주행: 첫 카메라 1km 앞에서 북쪽으로 가상 주행, ±10km/h 버튼으로 속도 조절.
