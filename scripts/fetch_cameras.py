"""전국무인교통단속카메라표준데이터(공공데이터포털 15028200) 전체를 받아 raw JSON으로 저장.
사용: DATA_GO_KR_KEY=... python3 -I scripts/fetch_cameras.py
키는 출력하지 않는다."""
import json, os, sys, time, urllib.parse, urllib.request
from pathlib import Path

KEY = os.environ.get("DATA_GO_KR_KEY", "").strip()
if not KEY:
    sys.exit("DATA_GO_KR_KEY 환경변수가 필요합니다")
URL = "https://api.data.go.kr/openapi/tn_pubr_public_unmanned_traffic_camera_api"
ROWS = 1000
OUT = Path(__file__).resolve().parent.parent / "data_raw" / "cameras_raw.json"

def get(page):
    # 키는 이미 인코딩된 형태일 수도, 아닐 수도 있어서 둘 다 시도
    for k in (KEY, urllib.parse.quote(KEY, safe="")):
        q = f"serviceKey={k}&pageNo={page}&numOfRows={ROWS}&type=json"
        try:
            with urllib.request.urlopen(f"{URL}?{q}", timeout=60) as r:
                txt = r.read().decode("utf-8")
            d = json.loads(txt)
        except Exception as e:  # noqa
            last = f"{type(e).__name__}"
            continue
        if "response" in d:
            return d["response"]
        if "header" in d and "body" in d:  # 이 API는 response 감싸개 없이 옴
            return d
        last = json.dumps(d, ensure_ascii=False)[:300]
    raise RuntimeError(f"page {page} 실패: {last}")

items, page, total = [], 1, None
while True:
    resp = get(page)
    hdr = resp.get("header", {})
    if hdr.get("resultCode") not in ("00", "0", None):
        sys.exit(f"API 오류: {hdr}")
    body = resp.get("body", {})
    total = int(body.get("totalCount", 0))
    batch = body.get("items") or []
    if isinstance(batch, dict):
        batch = batch.get("item", [])
    items.extend(batch)
    print(f"page {page}: +{len(batch)} (누적 {len(items)}/{total})", flush=True)
    if not batch or len(items) >= total:
        break
    page += 1
    time.sleep(0.2)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(items, ensure_ascii=False))
print(f"저장: {OUT} ({len(items)}건)")
