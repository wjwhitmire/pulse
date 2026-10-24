"""Generate tests/vectors.json: reference calls of the Python library that web/parity.test.mjs
replays against the JS core in web/app.html.

Each case is {"fn": <js function name>, "args": [...], "out": <python result>} or, for
expected failures, {"fn": ..., "args": [...], "error": <code>}. A few input kinds that JSON
cannot carry directly (bytes, XML documents) use small adapters named with a leading "@",
implemented the same way on both sides.

Run: python tests/make_vectors.py
"""

from __future__ import annotations

import base64
import json
import math
import random
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "src"))

import pulse as P  # noqa: E402
from pulse import analysis as A, recovery as R, util as U  # noqa: E402
from pulse.example import generate, mulberry32  # noqa: E402

from fitenc import FILE_ID, RECORD, FitWriter, fit_ts, record_values, sample_activity  # noqa: E402
from healthgen import export_xml, export_zip  # noqa: E402
import cases_extra  # noqa: E402

CASES = []


def jsonable(x):
    if isinstance(x, dict):
        return {str(k): jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [jsonable(v) for v in x]
    if isinstance(x, float) and not math.isfinite(x):
        return None
    return x


def case(fn, args, py):
    try:
        out = py(*args)
        CASES.append({"fn": fn, "args": jsonable(args), "out": jsonable(out)})
    except P.PulseError as e:
        CASES.append({"fn": fn, "args": jsonable(args), "error": e.code})


def b64(b):
    return base64.b64encode(b).decode()


def strip_analysis(r):
    return r  # Python output has no private keys; JS extras are ignored by the checker


S = A.settings_with(None)
START = 1767225600.0

# ---------------------------------------------------------------- util
for c in [(0, 0, 0, 1), (41.0, -40.0, 41.01, -40.02), (-33.9, 151.2, 51.5, -0.12), (10, 20, 10, 20), (0, 0, 0, 180)]:
    case("haversine", list(c), U.haversine)
for s in ["2026-01-01T00:00:00Z", "2026-01-01T01:00:00+01:00", "2026-01-01 00:00:00 -0500", "2026-03-04T05:06:07.125Z",
          "2026-01-01T00:00:00", "bad", "2026-13-01T00:00:00Z", "1999-12-31T23:59:60Z", "2026-02-30T07:00:00Z",
          "2024-02-29T07:00:00Z", "2026-03-08T02:30:00-06:00"]:
    case("parseTime", [s], U.parse_time)
for z in (-800000, -1, 0, 19000, 20747, 60000):
    case("dayStr", [z], U.day_str)
for s in ("2026-10-21", "2026-02-30", "26-10-21", "", "2024-02-29", "2026-02-29", "2026-04-31", "2026-12-31"):
    case("parseDay", [s], U.parse_day)
for s in (" 12.5 ", "-3e2", ".5", "nan", "1_0", "", "0x10"):
    case("num", [s], U.num)

# ---------------------------------------------------------------- FIT
def fit_case(data):
    case("@decodeFit", [b64(data)], lambda s: P.decode_fit(base64.b64decode(s)))


fit_case(sample_activity(n=150, compressed_every=3)[0])
fit_case(sample_activity(n=50, big_endian_records=True, header_size=12)[0])
fit_case(sample_activity(n=40, dev=True)[0])
fit_case(sample_activity(n=40, compressed_every=0, with_pause=False, sport=2)[0])
w = FitWriter()
w.define(0, 20, RECORD)
for i in range(3):
    w.data(0, record_values(START + i, 41, -40, 10, 100, 80, 150, i))
fit_case(w.finish(bad_crc=True))
fit_case(sample_activity(n=20)[0][:-25])
w = FitWriter()
w.raw(bytes([0x03, 1, 2, 3]))
fit_case(w.finish())
w = FitWriter()
w.define(0, 0, FILE_ID)
w.data(0, [32, fit_ts(START)])
fit_case(w.finish())
fit_case(b"hello world, not fit")
w = FitWriter()
w.define(0, 0, FILE_ID)
w.data(0, [4, fit_ts(START)])
w.define(1, 78, [(0, 10, 0x84)])
w.data(1, [[1000, 1010, 990, 1005, 0xFFFF]])
fit_case(w.finish())
w1 = FitWriter()
w1.define(0, 20, RECORD)
w1.data(0, record_values(START, 41, -40, 10, None, 80, None, 0))
w1.data(0, record_values(START, None, None, None, 120, None, 222, None))
w1.data(0, record_values(START + 1, 41.0001, -40, 10, 121, 80, 223, 11))
w2 = FitWriter()
w2.define(0, 20, RECORD)
w2.data(0, record_values(START + 2, 41.0002, -40, 10, 122, 80, 224, 22))
fit_case(w1.finish() + w2.finish())

# ---------------------------------------------------------------- GPX / TCX
import test_gpx as TG  # noqa: E402

xml_docs = [("gpx", TG.GPX), ("tcx", TG.TCX),
            ("gpx", '<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY a "aaaa">]><gpx>&a;</gpx>'),
            ("gpx", "<gpx><trk><trkseg><trkpt lat='1' lon='2'></trkseg></trk></gpx>"),
            ("gpx", "<kml></kml>"),
            ("gpx", "<gpx><trk><trkseg><trkpt lat='1' lon='2'><time>2026-01-01T00:00:00Z</time></trkpt></trkseg></trk></gpx>"),
            ("gpx", "<gpx>&undefined;</gpx>"),
            ("tcx", "<gpx/>"),
            ("gpx", """<gpx><trk><trkseg>
      <trkpt lat="95" lon="10"><time>2026-01-01T00:00:00Z</time></trkpt>
      <trkpt lat="41" lon="-40"><time>2026-01-01T00:00:05Z</time></trkpt>
      <trkpt lat="41" lon="-40"><time>2026-01-01T00:00:03Z</time></trkpt>
      <trkpt lat="abc" lon="-40"><time>2026-01-01T00:00:09Z</time></trkpt></trkseg></trk></gpx>""")]
for kind, doc in xml_docs:
    case("@parseXml", [kind, doc], lambda k, d: (P.parse_gpx if k == "gpx" else P.parse_tcx)(d.encode()))

# ---------------------------------------------------------------- analysis on constructed tracks
K = math.pi / 180 * 6371008.8


def track(seed, n=400):
    rnd = random.Random(seed)
    t = [START]
    d = [0.0]
    for _ in range(n - 1):
        t.append(t[-1] + rnd.choice([1.0, 1.0, 2.0, 3.0, 30.0 if rnd.random() < 0.01 else 1.0]))
        d.append(d[-1] + rnd.choice([0.0, rnd.uniform(0.2, 9.0), rnd.uniform(2, 5)]))
    ele = [100 + 20 * math.sin(i / 30) + rnd.uniform(-1, 1) if i % 17 else None for i in range(n)]
    hr = [130 + 40 * math.sin(i / 50) if i % 13 else None for i in range(n)]
    pwr = [max(0.0, 200 + 100 * math.sin(i / 20)) if seed % 2 else None for i in range(n)]
    return {"source": "test", "name": "", "sport": "ride" if seed % 2 else "run", "start": t[0], "t": t,
            "lat": [41.0 + x / K for x in d], "lon": [-40.0 + 0.00001 * i for i in range(n)], "ele": ele, "hr": hr,
            "cad": [None] * n, "pwr": pwr, "dist": [None] * n, "laps": [], "session": None,
            "pauses": [[START + 100, START + 130]] if seed == 3 else [], "rr": [], "warnings": []}


for seed in range(6):
    a = track(seed)
    for st in (None, {"units": "mi", "zone_method": "max", "trimp_sex": "female", "load_method": "edwards"}):
        case("analyze", [a, st], lambda a_, s_: A.analyze(a_, s_))
nohr = track(10)
nohr["hr"] = [None] * len(nohr["t"])
case("analyze", [nohr, None, 7], lambda a_, s_, r_: A.analyze(a_, s_, r_))
for vals, h in (([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), ([0, 5, 1, 6, 0], 3), ([10, 8, 11.5], 3), ([100, 99, 98, 101, 104, 103, 99], 2)):
    case("zigzag", [vals, h], lambda v, hh: list(A.zigzag(v, hh)))
for i in (-0.6, -0.2, -0.05, 0.0, 0.08, 0.3, 0.6):
    case("minettiCost", [i], A.minetti_cost)

# ---------------------------------------------------------------- load
case("loadSeries", [{"10": 100.0, "12": 40.0, "40": 80.0}, 10, 60, 42.0, 7.0],
     lambda d, a, b, f, g: P.load_series({int(k): v for k, v in d.items()}, a, b, f, g))
case("loadSeries", [{str(z): 30.0 + (z % 5) * 10 for z in range(0, 120)}, 0, 119, 28.0, 5.0],
     lambda d, a, b, f, g: P.load_series({int(k): v for k, v in d.items()}, a, b, f, g))

# ---------------------------------------------------------------- recovery
for rr in ([1000, 1010, 990, 1000] * 6, [1000.0, 1010.0] * 5 + [2500.0] + [1000.0, 1010.0] * 10, [800] * 5):
    case("rmssd", [rr], R.rmssd)
case("rrFromClock", [["11:59:59.50 AM", "12:00:00.40 PM", "23:59:59.6", "00:00:00.5", "7:00:00,10", "7:00:01,05"]], R.rr_from_clock)
case("unescapeXml", ["a &amp; b &lt;c&gt; &#65;&#x42; &trap;"], R.unescape)
xml3 = export_xml(4)
case("@scanHealth", [xml3, 997], lambda x, n: R.scan_text_chunks([x[i:i + n] for i in range(0, len(x), n)])[0])
# Review fix: semicolon CSVs from European spreadsheets write decimal commas.
case("parseDailyCsv", ["\ufeffdate;hrv_ms;resting_hr;sleep_hours\r\n2026-02-01;55,5;48;7,25\r\n"], R.parse_daily_csv)
# Review fix: '>' inside a quoted value, and an unterminated Record tag over 1 MB followed by a good one.
_rec = '<Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="a>b" unit="count/min" startDate="2026-03-01 07:00:00 -0500" endDate="2026-03-01 07:00:00 -0500" value="51"/>\n'
_hostile = "<HealthData>\n" + _rec + '<Record type="HKQuantityTypeIdentifierHeartRate" value="' + ">" * 1100000 + "\n" + _rec.replace("03-01", "03-02").replace('"51"', '"53"') + "</HealthData>\n"
case("@scanHealth", [_hostile, 65536], lambda x, n: R.scan_text_chunks([x[i:i + n] for i in range(0, len(x), n)])[0])
for method, z64 in ((zipfile.ZIP_DEFLATED, False), (zipfile.ZIP_STORED, False), (zipfile.ZIP_DEFLATED, True)):
    zb = export_zip(xml3, method, z64)

    def zip_py(s):
        import io
        raw = base64.b64decode(s)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            name = R.find_export_name([i.filename for i in zf.infolist()])
            info = zf.getinfo(name)
            with zf.open(name) as fh:
                days = R.scan_text_chunks([fh.read().decode("utf-8")])[0]
            return {"entries": [{"name": i.filename, "method": i.compress_type, "csize": i.compress_size,
                                 "usize": i.file_size, "lho": i.header_offset} for i in zf.infolist()],
                    "export": name, "days": days}
    case("@zipHealth", [b64(zb)], zip_py)
for text in ("date,hrv_ms,resting_hr,sleep_hours,extra\n2026-02-01,55,48,7.5,x\n\n2026-02-02,,49,\n",
             "2026-02-01\t60\t50\t8\n", "﻿Day;SDNN_ms;RHR\n2026-02-01;40;50\n",
             "", "when,hrv\n1,2\n", "date,hrv_ms\n2026-02-01,abc\n", "date,hrv_ms\n2026-02-01,900\n"):
    case("parseDailyCsv", [text], R.parse_daily_csv)

import test_load_recovery as TL  # noqa: E402
ready_series = [
    TL.series(70, TL.alt(4.0, 0.1), TL.alt(50, 1), lambda k: 8.0),
    TL.series(70, lambda k: 4.0 + (0.1 if k % 2 else -0.1) - (0.2 if k >= 63 else 0.0), TL.alt(50, 1), lambda k: 8.0),
    TL.series(70, lambda k: 4.0 + (0.1 if k % 2 else -0.1) - (0.2 if k >= 63 else 0.0),
              lambda k: 50 + (1 if k % 2 else -1) + (6 if k >= 67 else 0), lambda k: 8.0),
    TL.series(70, None, None, lambda k: 7.0 if k < 69 else 6.0),
    TL.series(70, lambda k: (4.0 + (0.05 if k % 2 else -0.05)) if k < 65 else None),
    TL.series(70, TL.alt(3.7, 0.1), metric="sdnn"),
]
for rows in ready_series:
    for day in (1040, 1069):
        case("@readiness", [rows, day, {"sleep_load_per100": 0.5}, {"1068": 200.0}],
             lambda r_, d_, s_, l_: (lambda o: dict(o, text=R.explain(o)))(
                 R.readiness(r_, d_, A.settings_with(s_), {int(k): v for k, v in l_.items()})))

# zero HRV values (from a damaged backup) are not a baseline; SDNN is used instead
zero_rows = [{"date": 1000 + k, "rmssd": 0.0, "sdnn": 40.0 + k % 3} for k in range(20)]
case("@readiness", [zero_rows, 1019, {}, {}],
     lambda r_, d_, s_, l_: (lambda o: dict(o, text=R.explain(o)))(R.readiness(r_, d_, A.settings_with(s_), {})))

# ---------------------------------------------------------------- example athlete
rnd = mulberry32(1)
case("@mulberry", [1, 5], lambda s, n: (lambda r: [r() for _ in range(n)])(mulberry32(s)))
END = U.parse_day("2026-10-21")


def example_summary(end, days):
    acts, daily = generate(end, days)
    out = []
    for a in acts:
        r = A.analyze(a, None)
        out.append({"name": a["name"], "n": len(a["t"]), "t_last": a["t"][-1], "lat_last": a["lat"][-1],
                    "hr_sum": sum(a["hr"]), "distance": r["distance"], "moving": r["moving"], "load": r["load"],
                    "gain": r["elevation"]["gain"], "fastest_1k": r["fastest"][1]["time"]})
    return {"acts": out, "daily": daily}


case("@example", [END, 90], example_summary)

for c in cases_extra.cases():
    case(*c)

out = {"tolerance_rel": 1e-9, "tolerance_abs": 1e-9, "cases": CASES}
(HERE / "vectors.json").write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"wrote tests/vectors.json ({len(CASES)} cases)")
