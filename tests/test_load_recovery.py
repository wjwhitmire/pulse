import math
import zipfile

import pytest

from healthgen import RR_A, RR_B, export_xml, export_zip
from pulse import PulseError, daily_loads, load_series, parse_daily_csv, readiness, rmssd, settings_with
from pulse.recovery import (HealthScanner, explain, find_export_name, read_health, rr_from_clock,
                                scan_text_chunks, sleep_nights, unescape)
from pulse.util import parse_day

S = settings_with(None)
D0 = parse_day("2026-02-01")


# ------------------------------------------------------------------ load

def test_ewma_single_impulse_decays():
    r = load_series({10: 100.0}, 10, 20)
    kf = 1 - math.exp(-1 / 42)
    kd = 1 - math.exp(-1 / 7)
    assert r["fitness"][0] == pytest.approx(100 * kf)
    assert r["fatigue"][0] == pytest.approx(100 * kd)
    assert r["fitness"][5] == pytest.approx(100 * kf * math.exp(-5 / 42))
    assert r["fatigue"][10] == pytest.approx(100 * kd * math.exp(-10 / 7))


def test_form_is_previous_day_balance():
    r = load_series({10: 100.0}, 10, 12)
    assert r["form"][0] == 0.0
    assert r["form"][1] == pytest.approx(r["fitness"][0] - r["fatigue"][0])
    assert r["form"][1] < 0


def test_constant_load_converges_and_taus_editable():
    r = load_series({z: 50.0 for z in range(0, 400)}, 0, 399)
    assert r["fitness"][-1] == pytest.approx(50.0, rel=1e-3)
    assert r["fatigue"][-1] == pytest.approx(50.0, rel=1e-12)
    r2 = load_series({0: 10.0}, 0, 0, fit_tau=28, fat_tau=5)
    assert r2["fitness"][0] == pytest.approx(10 * (1 - math.exp(-1 / 28)))


def test_ratio_is_uncoupled_and_descriptive():
    daily = {z: (20.0 if z < 21 else 40.0) for z in range(0, 28)}
    r = load_series(daily, 0, 27)
    assert r["ratio"][26] is None
    assert r["ratio"][27] == pytest.approx(40.0 / 20.0)  # last 7 days vs the 21 days before them
    assert load_series({}, 0, 30)["ratio"][30] is None
    assert load_series({}, 5, 4)["day"] == []


def test_daily_loads_sums_and_skips_none():
    assert daily_loads([(1, 10.0), (1, 5.0), (2, None), (3, 1.0)]) == {1: 15.0, 3: 1.0}


# ------------------------------------------------------------------ HRV maths

def test_rmssd_hand_case():
    rr = [1000, 1010, 990, 1000] * 6
    diffs = [rr[i] - rr[i - 1] for i in range(1, len(rr))]
    assert rmssd(rr) == pytest.approx(math.sqrt(sum(x * x for x in diffs) / len(diffs)))
    assert rmssd(rr[:10]) is None  # under 20 pairs


def test_rmssd_artifact_filter():
    rr = [1000.0, 1010.0] * 15
    clean = rmssd(rr)
    dirty = list(rr)
    dirty[10] = 2500.0   # out of range
    dirty[20] = 1600.0   # over 25 % from the median
    r = rmssd(dirty)
    assert r == pytest.approx(clean)


def test_rr_from_clock_handles_ampm_noon_and_24h():
    assert rr_from_clock(["11:59:59.50 AM", "12:00:00.40 PM"]) == pytest.approx([900.0])
    assert rr_from_clock(["23:59:59.6", "00:00:00.5"]) == pytest.approx([900.0])
    assert rr_from_clock(["7:00:00,10", "7:00:01,05"]) == pytest.approx([950.0])


def test_unescape_never_expands_named_entities():
    assert unescape("a &amp; b &lt;c&gt; &#65;&#x42; &trap;") == "a & b <c> AB &trap;"


# ------------------------------------------------------------------ Apple Health

def _by_day(rows):
    return {r["date"]: r for r in rows}


def test_scanner_reads_records_and_ignores_dtd():
    rows, n = scan_text_chunks([export_xml(3)])
    d = _by_day(rows)
    assert set(d) == {D0, D0 + 1, D0 + 2}
    assert d[D0]["rhr"] == 50.0 and d[D0 + 2]["rhr"] == 52.0
    assert d[D0]["sdnn"] == pytest.approx(40.0)  # the 15:00 reading is not used: a morning one exists
    assert d[D0]["rmssd"] == pytest.approx(rmssd(RR_A), abs=1.0)
    assert d[D0 + 1]["rmssd"] == pytest.approx(rmssd(RR_B), abs=1.0)
    # union of the two sources: 22:50 to 06:30 is 7 h 40 min; awake and in-bed are excluded
    assert d[D0]["sleep"] == pytest.approx(7 + 40 / 60)
    assert d[D0]["stages"] == pytest.approx({"core": 3.0, "deep": 1.0, "rem": 3 + 10 / 60, "unspecified": 0.0})
    assert d[D0 + 1]["nap"] == pytest.approx(40 / 60)
    assert n == 3 * 10 + 1  # step records now read too; the in-bed record is not counted as asleep


def test_scanner_is_chunk_size_independent():
    xml = export_xml(2)
    whole, _ = scan_text_chunks([xml])
    for size in (1, 7, 64, 1000):
        parts = [xml[i:i + size] for i in range(0, len(xml), size)]
        got, _ = scan_text_chunks(parts)
        assert got == whole


def test_scanner_quote_aware_tag_end():
    sc = HealthScanner()
    sc.feed('<Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="a > b" '
            'startDate="2026-02-01 06:00:00 -0500" value="47"/><RecordX type="x"/>')
    assert sc.result()[0]["rhr"] == 47.0


def test_export_zip_deflate_stored_and_zip64(tmp_path):
    xml = export_xml(3)
    ref, _ = scan_text_chunks([xml])
    for method, z64 in ((zipfile.ZIP_DEFLATED, False), (zipfile.ZIP_STORED, False), (zipfile.ZIP_DEFLATED, True)):
        p = tmp_path / f"export_{method}_{z64}.zip"
        p.write_bytes(export_zip(xml, method, z64))
        rows, _ = read_health(str(p))
        assert rows == ref
    p = tmp_path / "export.xml"
    p.write_text(xml, encoding="utf-8")
    assert read_health(str(p))[0] == ref


def test_export_zip_without_export_xml(tmp_path):
    import io
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as zf:
        zf.writestr("apple_health_export/export_cda.xml", "x")
    p = tmp_path / "e.zip"
    p.write_bytes(b.getvalue())
    with pytest.raises(PulseError) as e:
        read_health(str(p))
    assert e.value.code == "zip"
    assert find_export_name(["a/export_cda.xml", "x/y/export.xml", "z/export.xml"]) == "z/export.xml"


def test_sleep_nap_rules():
    def iv(a, b):
        return (parse_ts(a), parse_ts(b), a, b, "core", "w")
    from pulse.util import parse_time as parse_ts
    main, nap = sleep_nights([iv("2026-02-01 23:00:00 +0000", "2026-02-02 03:00:00 +0000"),
                              iv("2026-02-02 03:45:00 +0000", "2026-02-02 07:00:00 +0000"),
                              iv("2026-02-02 13:00:00 +0000", "2026-02-02 13:30:00 +0000"),
                              iv("2026-02-02 21:00:00 +0000", "2026-02-02 22:00:00 +0000")])
    z = parse_day("2026-02-02")
    assert main[z] == pytest.approx(4 + 3.25 + 1.0)  # evening doze is not a nap (starts 21:00)
    assert nap[z] == pytest.approx(0.5)


# ------------------------------------------------------------------ CSV

def test_csv_with_header_and_without():
    rows = parse_daily_csv("date,hrv_ms,resting_hr,sleep_hours,extra\n2026-02-01,55,48,7.5,x\n\n2026-02-02,,49,\n")
    assert rows[0]["rmssd"] == 55.0 and rows[0]["sleep"] == 7.5
    assert rows[1]["rmssd"] is None and rows[1]["rhr"] == 49.0
    rows = parse_daily_csv("2026-02-01\t60\t50\t8\n")
    assert rows[0]["rmssd"] == 60.0 and rows[0]["sleep"] == 8.0
    rows = parse_daily_csv("﻿Day;SDNN_ms;RHR\n2026-02-01;40;50\n")
    assert rows[0]["sdnn"] == 40.0 and rows[0]["rmssd"] is None


@pytest.mark.parametrize("text,frag", [
    ("", "empty"), ("when,hrv\n1,2\n", "no 'date'"), ("date,hrv_ms\n2026-02-01,abc\n", "not a number"),
    ("date,hrv_ms\n02/01/2026,50\n", "YYYY-MM-DD"), ("date,hrv_ms\n2026-02-01,900\n", "outside"),
    ("date,resting_hr\n2026-02-01,5\n", "outside"), ("date,sleep_hours\n2026-02-01,30\n", "outside"),
])
def test_csv_errors(text, frag):
    with pytest.raises(PulseError) as e:
        parse_daily_csv(text)
    assert frag in str(e.value)


def test_csv_row_limit(monkeypatch):
    import pulse.recovery as r
    monkeypatch.setattr(r, "MAX_ROWS", 3)
    with pytest.raises(PulseError) as e:
        parse_daily_csv("date,rhr\n" + "2026-02-01,50\n" * 5)
    assert e.value.code == "rows"


# ------------------------------------------------------------------ readiness rules

def series(n, ln_hrv=None, rhr=None, sleep=None, metric="rmssd", start=1000):
    rows = []
    for k in range(n):
        rows.append({"date": start + k,
                     "rmssd": math.exp(ln_hrv(k)) if ln_hrv and metric == "rmssd" and ln_hrv(k) is not None else None,
                     "sdnn": math.exp(ln_hrv(k)) if ln_hrv and metric == "sdnn" and ln_hrv(k) is not None else None,
                     "rhr": rhr(k) if rhr else None, "sleep": sleep(k) if sleep else None, "nap": None, "stages": None})
    return rows


def alt(base, amp):
    return lambda k: base + (amp if k % 2 else -amp)


def test_readiness_clear():
    rows = series(70, alt(4.0, 0.1), alt(50, 1), lambda k: 8.0)
    r = readiness(rows, 1069, S)
    assert r["state"] == "clear" and r["flags"] == []
    assert r["hrv"]["status"] == "normal" and r["hrv"]["base_n"] == 60
    assert r["hrv"]["lo"] == pytest.approx(4.0 - 0.5 * r["hrv"]["sd"])
    assert explain(r).startswith("No input is off")


def test_readiness_one_off_from_hrv_only():
    rows = series(70, lambda k: 4.0 + (0.1 if k % 2 else -0.1) - (0.2 if k >= 63 else 0.0), alt(50, 1), lambda k: 8.0)
    r = readiness(rows, 1069, S)
    assert r["flags"] == ["hrv"] and r["state"] == "one_off" and r["hrv"]["status"] == "low"


def test_readiness_several_off_from_hrv_and_rhr():
    rows = series(70, lambda k: 4.0 + (0.1 if k % 2 else -0.1) - (0.2 if k >= 63 else 0.0),
                  lambda k: 50 + (1 if k % 2 else -1) + (6 if k >= 67 else 0), lambda k: 8.0)
    r = readiness(rows, 1069, S)
    assert r["flags"] == ["hrv", "rhr"] and r["state"] == "several_off"


def test_readiness_sleep_need_terms():
    rows = series(70, None, None, lambda k: 7.0 if k < 69 else 6.0)
    rows[67]["nap"] = 0.5
    r = readiness(rows, 1068, dict(S, sleep_debt_share=0.1))
    sl = r["sleep"]
    assert sl["debt"] == pytest.approx(7.0) and sl["nap"] == 0.5
    assert sl["need"] == pytest.approx(8.0 + 0.7 - 0.5)
    r = readiness(rows, 1069, dict(S, sleep_load_per100=0.5), loads={1068: 200.0})
    assert r["sleep"]["need"] == pytest.approx(8.0 + 0.7 + 1.0)
    assert r["sleep"]["ratio"] == pytest.approx(6.0 / 9.7) and r["flags"] == ["sleep"]


def test_readiness_needs_three_readings_in_week_and_14_baseline_days():
    rows = series(70, lambda k: (4.0 + (0.05 if k % 2 else -0.05)) if k < 65 else None)
    r = readiness(rows, 1069, S)
    assert r["hrv"]["week_n"] == 2 and r["hrv"]["status"] == "insufficient" and r["state"] == "none"
    r = readiness(series(10, alt(4.0, 0.1)), 1009, S)
    assert r["hrv"] is None and r["state"] == "none"
    assert "Not enough" in explain(r)


def test_readiness_never_mixes_sdnn_into_rmssd():
    rows = series(70, alt(3.7, 0.1), metric="sdnn")
    for k in range(63, 70):  # a week of rMSSD readings only, far higher than the SDNN numbers
        rows[k]["rmssd"] = 90.0
    r = readiness(rows, 1069, S)
    assert r["hrv"]["metric"] == "sdnn"  # rMSSD lacks a 14-day baseline, so SDNN is used alone
    assert r["hrv"]["roll"] == pytest.approx(sum(3.7 + (0.1 if k % 2 else -0.1) for k in range(63, 70)) / 7)


def test_no_traffic_light_words_in_readiness_text():
    # Review fix: readiness is never described as a traffic light (design rule), in the CLI
    # explanation or in the suggested session's reason.
    from pulse.logs import suggest
    import re
    bad = re.compile(r"\b(red|amber|green|yellow)\b", re.I)
    base = series(70, lambda k: 4.0 + (0.1 if k % 2 else -0.1), lambda k: 50 + (1 if k % 2 else -1), lambda k: 8.0)
    cases = [base,
             series(70, lambda k: 4.0 + (0.1 if k % 2 else -0.1) - (0.2 if k >= 63 else 0.0), alt(50, 1), lambda k: 8.0),
             series(70, lambda k: 4.0 + (0.1 if k % 2 else -0.1) - (0.2 if k >= 63 else 0.0),
                    lambda k: 50 + (1 if k % 2 else -1) + (6 if k >= 67 else 0), lambda k: 8.0)]
    states = set()
    for rows in cases:
        r = readiness(rows, 1069, S)
        states.add(r["state"])
        assert not bad.search(r["state"]) and not bad.search(explain(r))
        sg = suggest([], r, {"fitness": [50.0], "form": [-2.0]}, 1069)
        assert not bad.search(sg["reason"]), sg["reason"]
    assert states == {"clear", "one_off", "several_off"}


def test_health_scanner_hostile_tags_are_linear_and_bounded():
    # Review fix: the tag-end search recounted quotes from the tag start for every '>' (quadratic),
    # and an unterminated <Record tag was buffered without limit.
    import time
    sc = HealthScanner()
    t0 = time.perf_counter()
    sc.feed('<Record type="HKQuantityTypeIdentifierHeartRate" value="')
    for _ in range(20):
        sc.feed(">" * 10000)
    assert time.perf_counter() - t0 < 5.0
    sc = HealthScanner()
    sc.feed("<HealthData><Record type=x ")
    for _ in range(4):
        sc.feed("y" * (1 << 20))
    assert len(sc.buf) <= (1 << 20) + 16


def test_health_zip_bomb_is_refused(tmp_path):
    # Review fix: inflating export.xml is capped at 100 x its compressed size.
    p = tmp_path / "export.zip"
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("apple_health_export/export.xml", "<HealthData>" + " " * (300 * 1024 * 1024) + "</HealthData>")
    with pytest.raises(PulseError) as e:
        read_health(str(p))
    assert e.value.code == "zip"


def test_daily_csv_semicolon_decimal_comma():
    # Review fix: European spreadsheets export ";" separated files with decimal commas.
    r = parse_daily_csv("date;hrv_ms;resting_hr;sleep_hours\n2026-02-01;55,5;48;7,25\n")[0]
    assert r["rmssd"] == 55.5 and r["sleep"] == 7.25 and r["rhr"] == 48
