"""raw 카메라 데이터(API JSON 또는 포털 CSV) → 앱용 압축 web/cams.json.

사용:
  python3 -I scripts/build_cams.py data_raw/cameras_raw.json
  python3 -I scripts/build_cams.py data_raw/전국무인교통단속카메라표준데이터.csv
  python3 -I scripts/build_cams.py --sample          # 테스트용 샘플(서울시청 근처)

출력 형식: {"v": 날짜, "src": 출처, "n": 개수, "c": [[lat, lon, 제한속도, flags, 구간길이m, 라벨], ...]}
flags: 1=구간단속 시점, 2=구간단속 종점, 4=보호구역(어린이 등)
"""
import csv, json, math, sys, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "cams.json"

# 같은 의미의 필드명 후보 (API 영문키 / CSV 한글 헤더)
F = {
    "lat": ["latitude", "위도"],
    "lon": ["longitude", "경도"],
    "limit": ["lmttVe", "제한속도"],
    "kind": ["regltSe", "단속구분"],
    "sect": ["regltSctnLcSe", "단속구간위치구분"],
    "sectlen": ["ovrspdRegltSctnLt", "과속단속구간길이"],
    "zone": ["prtcareaType", "보호구역구분"],
    "place": ["itlpc", "설치장소"],
    "road": ["roadRouteNm", "도로노선명"],
}


def pick(row, key):
    for k in F[key]:
        if k in row and str(row[k]).strip() not in ("", "None", "null"):
            return str(row[k]).strip()
    return ""


def num(s, default=0.0):
    try:
        return float(str(s).replace(",", "").replace("km", "").replace("m", "").strip())
    except ValueError:
        return default


def load(path: Path):
    if path.suffix.lower() == ".json":
        d = json.loads(path.read_text(encoding="utf-8"))
        return d if isinstance(d, list) else d.get("items", [])
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp949", "euc-kr"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    return list(csv.DictReader(text.splitlines()))


def convert(rows):
    out, seen, skipped = [], set(), {"좌표없음": 0, "제한속도없음": 0, "중복": 0}
    for r in rows:
        lat, lon = num(pick(r, "lat")), num(pick(r, "lon"))
        if not (33 < lat < 39 and 124 < lon < 132):
            skipped["좌표없음"] += 1
            continue
        limit = int(num(pick(r, "limit")))
        if limit <= 0 or limit > 130:
            skipped["제한속도없음"] += 1
            continue
        flags = 0
        sect = pick(r, "sect")
        if "시점" in sect or "시작" in sect:
            flags |= 1
        elif "종점" in sect or "끝" in sect:
            flags |= 2
        zone = pick(r, "zone")
        if zone and zone not in ("99", "해당없음", "없음", "0"):
            flags |= 4
        sl = num(pick(r, "sectlen"))
        sect_m = int(sl * 1000) if 0 < sl < 100 else int(sl)  # km 또는 m 표기 모두 처리
        label = pick(r, "place") or pick(r, "road")
        key = (round(lat, 5), round(lon, 5), limit)
        if key in seen:
            skipped["중복"] += 1
            continue
        seen.add(key)
        out.append([round(lat, 6), round(lon, 6), limit, flags, sect_m, label[:40]])
    return out, skipped


def sample():
    """서울시청(37.5663,126.9779)에서 북쪽으로 이어지는 가상의 직선 도로 위 카메라."""
    lat0, lon0 = 37.5663, 126.9779
    m = lambda north, east=0.0: [round(lat0 + north / 110540, 6),
                                round(lon0 + east / (111320 * math.cos(math.radians(lat0))), 6)]
    return [
        m(1000) + [50, 0, 0, "샘플 고정식 (1km 지점)"],
        m(2500) + [30, 4, 0, "샘플 어린이보호구역 (2.5km)"],
        m(4000) + [60, 1, 1500, "샘플 구간단속 시점 (4km)"],
        m(5500) + [60, 2, 1500, "샘플 구간단속 종점 (5.5km)"],
        m(1000, -120) + [80, 0, 0, "샘플 옆 도로 (무시돼야 함)"],
    ]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    if sys.argv[1] == "--sample":
        cams, src, skipped = sample(), "샘플", {}
    else:
        p = Path(sys.argv[1])
        cams, skipped = convert(load(p))
        src = "전국무인교통단속카메라표준데이터"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    data = {"v": datetime.date.today().isoformat(), "src": src, "n": len(cams), "c": cams}
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT}: {len(cams)}건, 제외 {skipped}, {OUT.stat().st_size/1024:.0f}KB")


if __name__ == "__main__":
    main()
