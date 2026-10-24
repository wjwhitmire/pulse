import math
import struct

import pytest

from fitenc import FILE_ID, RECORD, FitWriter, fit_ts, record_values, sample_activity
from pulse import PulseError, decode_fit, haversine
from pulse.fit import FIT_EPOCH, crc16
from pulse.util import civil_from_days, day_str, days_from_civil, num, parse_day, parse_time, project_local

START = 1767225600.0  # 2026-01-01T00:00:00Z


# ------------------------------------------------------------------ util

def test_haversine_one_degree_on_equator():
    assert haversine(0, 0, 0, 1) == pytest.approx(2 * math.pi * 6371008.8 / 360, rel=1e-12)


def test_haversine_meridian_and_symmetry():
    d = haversine(41.0, -40.0, 41.01, -40.0)
    assert d == pytest.approx(0.01 * math.pi / 180 * 6371008.8, rel=1e-9)
    assert haversine(41.01, -40.0, 41.0, -40.0) == d
    assert haversine(10, 20, 10, 20) == 0.0


def test_haversine_antipodes_clamped():
    assert haversine(0, 0, 0, 180) == pytest.approx(math.pi * 6371008.8, rel=1e-12)


def test_projection_equal_aspect():
    x, y = project_local(41.001, -39.999, 41.0, -40.0)
    assert y == pytest.approx(0.001 * math.pi / 180 * 6371008.8)
    assert x == pytest.approx(0.001 * math.pi / 180 * 6371008.8 * math.cos(math.radians(41.0)))


def test_civil_round_trip():
    for z in (-800000, -1, 0, 1, 19000, 20747, 60000):
        assert days_from_civil(*civil_from_days(z)) == z
    assert day_str(0) == "1970-01-01"
    assert parse_day("2026-10-21") == days_from_civil(2026, 10, 21)
    assert parse_day("2026-13-01") is None and parse_day("21/10/2026") is None


def test_parse_time_forms():
    assert parse_time("2026-01-01T00:00:00Z") == START
    assert parse_time("2026-01-01T01:00:00+01:00") == START
    assert parse_time("2026-01-01 00:00:00 -0500") == START + 5 * 3600
    assert parse_time("2026-01-01T00:00:00.250Z") == START + 0.25
    assert parse_time("2026-01-01T00:00:00") == START  # no zone: read as UTC
    assert parse_time("yesterday") is None and parse_time(None) is None


def test_num_is_strict():
    assert num(" 12.5 ") == 12.5 and num("-3e2") == -300.0 and num(".5") == 0.5
    for bad in ("nan", "inf", "1_0", "", "12a", "0x10"):
        assert num(bad) is None


# ------------------------------------------------------------------ FIT

def test_fit_crc_known_value():
    assert crc16(b"") == 0
    assert crc16(b"123456789") == 0xBB3D  # CRC-16/ARC check value; FIT uses the same polynomial


def test_fit_decodes_records_with_compressed_timestamps():
    data, rows = sample_activity(n=150, compressed_every=3)
    a = decode_fit(data)
    assert a["warnings"] == []
    assert a["sport"] == "run" and a["start"] == START
    assert a["t"] == [r[0] for r in rows]  # compressed headers rebuilt every timestamp, across rollovers
    for i, r in enumerate(rows):
        assert a["lat"][i] == pytest.approx(r[1], abs=1e-7)
        assert a["lon"][i] == pytest.approx(r[2], abs=1e-7)
        assert a["ele"][i] == pytest.approx(r[3], abs=0.2)
        assert a["hr"][i] == r[4] and a["cad"][i] == r[5] and a["pwr"][i] == r[6]
        assert a["dist"][i] == pytest.approx(r[7], abs=0.01)


def test_fit_session_lap_and_pause():
    data, _ = sample_activity(n=60)
    a = decode_fit(data)
    assert a["session"]["distance"] == pytest.approx(59 * 3.0)
    assert a["session"]["timer"] == 59.0 and a["session"]["avg_hr"] == 140
    assert len(a["laps"]) == 1 and a["laps"][0]["max_hr"] == 159
    assert a["pauses"] == [[START + 30, START + 35]]


def test_fit_big_endian_definition_and_12_byte_header():
    d1, rows = sample_activity(n=40, big_endian_records=True, header_size=12)
    a = decode_fit(d1)
    assert a["t"] == [r[0] for r in rows]
    assert a["hr"] == [r[4] for r in rows]


def test_fit_developer_fields_are_skipped():
    with_dev, _ = sample_activity(n=30, dev=True)
    without, _ = sample_activity(n=30, dev=False)
    assert len(with_dev) > len(without)
    a, b = decode_fit(with_dev), decode_fit(without)
    for k in ("t", "lat", "lon", "hr", "pwr"):
        assert a[k] == b[k]


def test_fit_bad_crc_is_a_warning():
    w = FitWriter()
    w.define(0, 20, RECORD)
    for i in range(3):
        w.data(0, record_values(START + i, 41, -40, 10, 100, 80, 150, i))
    a = decode_fit(w.finish(bad_crc=True))
    assert "file CRC mismatch" in a["warnings"] and len(a["t"]) == 3


def test_fit_truncated_data_message_raises():
    data, _ = sample_activity(n=20)
    cut = data[:-25]
    with pytest.raises(PulseError) as e:
        decode_fit(cut)
    assert e.value.code in ("fit_truncated",)


def test_fit_undefined_local_type():
    w = FitWriter()
    w.raw(bytes([0x03, 1, 2, 3]))
    with pytest.raises(PulseError) as e:
        decode_fit(w.finish())
    assert e.value.code == "fit_def"


def test_fit_compressed_before_any_timestamp():
    w = FitWriter()
    w.define(0, 20, RECORD[1:])
    w.data(0, record_values(START, 41, -40, 10, 100, 80, 150, 0)[1:], compressed=3)
    with pytest.raises(PulseError) as e:
        decode_fit(w.finish())
    assert e.value.code == "fit_def"


def test_fit_rejects_non_activity_and_garbage():
    w = FitWriter()
    w.define(0, 0, FILE_ID)
    w.data(0, [32, fit_ts(START)])
    with pytest.raises(PulseError) as e:
        decode_fit(w.finish())
    assert e.value.code == "fit_type"
    for bad in (b"", b"hello world, not fit", bytes([14]) + b"\0" * 7 + b"NOPE" + b"\0" * 10):
        with pytest.raises(PulseError) as e:
            decode_fit(bad)
        assert e.value.code == "fit_header"


def test_fit_invalid_sentinels_become_none():
    w = FitWriter()
    w.define(0, 20, RECORD)
    for i in range(3):
        w.data(0, record_values(START + i, None, None, None, None, None, None, i * 2.0))
    a = decode_fit(w.finish())
    assert a["lat"] == [None] * 3 and a["hr"] == [None] * 3 and a["ele"] == [None] * 3
    assert a["dist"] == [0.0, 2.0, 4.0]


def test_fit_chained_files_and_duplicate_timestamps():
    w1 = FitWriter()
    w1.define(0, 20, RECORD)
    w1.data(0, record_values(START, 41, -40, 10, None, 80, None, 0))
    w1.data(0, record_values(START, None, None, None, 120, None, 222, None))  # same second: merged
    w1.data(0, record_values(START + 1, 41.0001, -40, 10, 121, 80, 223, 11))
    w2 = FitWriter()
    w2.define(0, 20, RECORD)
    w2.data(0, record_values(START + 2, 41.0002, -40, 10, 122, 80, 224, 22))
    a = decode_fit(w1.finish() + w2.finish())
    assert a["t"] == [START, START + 1, START + 2]
    assert a["hr"] == [120, 121, 122] and a["pwr"] == [222, 223, 224]


def test_fit_hrv_rr_intervals():
    w = FitWriter()
    w.define(0, 0, FILE_ID)
    w.data(0, [4, fit_ts(START)])
    w.define(1, 78, [(0, 10, 0x84)])
    w.data(1, [[1000, 1010, 990, 1005, 0xFFFF]])
    a = decode_fit(w.finish())
    assert a["rr"] == [1000, 1010, 990, 1005]


def test_fit_epoch_constant():
    assert FIT_EPOCH == days_from_civil(1989, 12, 31) * 86400
    assert struct.calcsize("<I") == 4


def test_fit_message_cap():
    # Review fix: millions of tiny data messages are refused instead of filling memory.
    from pulse import PulseError, decode_fit
    import pytest as _pt
    n = 3_100_000
    b = bytearray(14 + 6 + n)
    b[0] = 14
    b[4:8] = (6 + n).to_bytes(4, "little")
    b[8:12] = b".FIT"
    b[14:20] = bytes([0x40, 0, 0, 20, 0, 0])
    with _pt.raises(PulseError) as e:
        decode_fit(bytes(b))
    assert e.value.code == "size"
