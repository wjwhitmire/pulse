import math
import random

import pytest

from pulse import analyze, settings_with
from pulse.analysis import (bad_prefix, cumdist, elevation, fastest, grade_adjusted, heart,
                                minetti_cost, moving_mask, power, smooth, splits, zigzag, zone_bounds)

K = math.pi / 180 * 6371008.8  # metres per degree of latitude
S = settings_with(None)


def act(t, d, ele=None, hr=None, pwr=None, sport="run", pauses=()):
    n = len(t)
    return {"source": "test", "name": "", "sport": sport, "start": t[0], "t": list(t),
            "lat": [41.0 + x / K for x in d], "lon": [-40.0] * n,
            "ele": list(ele) if ele else [None] * n, "hr": list(hr) if hr else [None] * n,
            "cad": [None] * n, "pwr": list(pwr) if pwr else [None] * n, "dist": [None] * n,
            "laps": [], "session": None, "pauses": list(pauses), "rr": [], "warnings": []}


def test_cumdist_on_meridian_and_fallback():
    a = act([0, 1, 2, 3], [0, 10, 25, 25])
    d = cumdist(a)
    assert d == pytest.approx([0, 10, 25, 25], abs=1e-6)
    a["lat"] = [None] * 4
    a["dist"] = [5.0, None, 30.0, 25.0]  # device distance, forward filled, never decreasing
    assert cumdist(a) == [0.0, 0.0, 25.0, 25.0]
    a["dist"] = [None] * 4
    assert cumdist(a) == [0.0] * 4


def test_moving_time_constant_speed_and_stop():
    t = list(range(0, 101))
    d = [3.0 * min(i, 50) + 3.0 * max(0, i - 80) for i in t]  # moves 50 s, stands 30 s, moves 20 s
    mov = moving_mask(t, d, "run", S)
    assert sum(1 for i in range(1, 101) if mov[i]) == 70


def test_moving_time_short_stop_counts_as_moving():
    t = list(range(0, 21))
    d = [3.0 * i if i <= 10 else 30.0 + 3.0 * max(0, i - 13) for i in t]  # 3 s standstill
    mov = moving_mask(t, d, "run", S)
    assert all(mov[1:])


def test_moving_time_hysteresis_band():
    # 0.6 m/s is between stop (0.5) and go (0.8): it keeps whatever state came before
    t = list(range(0, 31))
    v = [3.0] * 10 + [0.0] * 10 + [0.6] * 10
    d = [0.0]
    for x in v:
        d.append(d[-1] + x)
    mov = moving_mask(t, d, "run", S)
    assert mov[1:11] == [True] * 10 and not any(mov[11:31])
    s2 = dict(S, min_stop=0.0)
    mov2 = moving_mask(t, d, "run", s2)
    assert not any(mov2[11:])


def test_moving_respects_device_pause():
    t = list(range(0, 21))
    d = [3.0 * i for i in t]
    mov = moving_mask(t, d, "run", S, pauses=[(5, 10)])
    assert [i for i in range(1, 21) if not mov[i]] == [6, 7, 8, 9, 10]


def test_ride_thresholds_differ():
    t = list(range(0, 11))
    d = [0.9 * i for i in t]
    assert all(moving_mask(t, d, "run", S)[1:])
    assert not any(moving_mask(t, d, "ride", S)[1:])


def test_smooth_and_zigzag_hand_cases():
    assert smooth([0, 0, 10, 0, 0], 3) == pytest.approx([0, 10 / 3, 10 / 3, 10 / 3, 0])
    assert zigzag([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3) == (10.0, 0.0)
    assert zigzag([0, 2, 0, 2, 0, 2, 0], 3) == (0.0, 0.0)
    assert zigzag([0, 5, 1, 6, 0], 3) == (10.0, 10.0)
    assert zigzag([10, 8, 11.5], 3) == (3.5, 0.0)
    assert zigzag([], 3) == (0.0, 0.0)


def test_elevation_raw_versus_corrected():
    rnd = random.Random(1)
    ele = [100 + 0.2 * i + rnd.uniform(-1, 1) for i in range(200)]
    e = elevation(ele, S)
    assert e["raw_gain"] > 60  # noise inflates the raw sum
    assert e["gain"] == pytest.approx(39.8, abs=1.5)
    assert e["loss"] == 0.0
    assert elevation([None, 5.0], S) is None


def test_splits_constant_speed():
    t = [float(i) for i in range(0, 2501)]
    d = [1.0 * i for i in range(0, 2501)]  # 1 m/s for 2500 m
    a = act(t, d, ele=[x / 100 for x in d], hr=[150.0] * 2501)
    r = analyze(a, S)
    sp = r["splits"]
    assert [round(s["distance"], 6) for s in sp] == [1000.0, 1000.0, 500.0]
    for s_ in sp:
        assert s_["elapsed"] == pytest.approx(s_["distance"], rel=1e-9)
        assert s_["moving"] == pytest.approx(s_["distance"], rel=1e-6)
        assert s_["avg_hr"] == pytest.approx(150.0)
    assert sp[0]["ele_delta"] == pytest.approx(10.0, abs=0.02)  # smoothing edge at the start
    assert sp[1]["ele_delta"] == pytest.approx(10.0, abs=1e-6)
    mi = analyze(a, dict(S, units="mi"))["splits"]
    assert mi[0]["distance"] == pytest.approx(1609.344) and len(mi) == 2


def test_splits_short_remainder_dropped():
    t = list(range(0, 1006))
    d = [float(i) for i in t]
    mov = [True] * len(t)
    assert len(splits(t, d, mov, None, [None] * len(t), 1000.0, S)) == 1


def brute_fastest(t, d, D, bad):
    best = None
    n = len(t)
    for i in range(n):
        for j in range(i + 1, n):
            if d[j] - d[i] >= D:
                if bad[j] - bad[i] == 0:
                    x = d[i] + D
                    f = (x - d[j - 1]) / (d[j] - d[j - 1])
                    el = t[j - 1] + f * (t[j] - t[j - 1]) - t[i]
                    best = el if best is None or el < best else best
                break
    for j in range(n):
        for i in range(j - 1, -1, -1):
            if d[j] - d[i] >= D:
                if bad[j] - bad[i] == 0:
                    x = d[j] - D
                    f = (x - d[i]) / (d[i + 1] - d[i])
                    el = t[j] - (t[i] + f * (t[i + 1] - t[i]))
                    best = el if best is None or el < best else best
                break
    return best


def dense_fastest(t, d, D, step=0.25):
    """Independent check: sample the piecewise-linear time-of-distance on a fine grid."""
    import bisect

    def time_at(x):
        j = bisect.bisect_left(d, x)
        if j == 0:
            return t[0]
        return t[j - 1] + (x - d[j - 1]) / (d[j] - d[j - 1]) * (t[j] - t[j - 1])
    best = None
    x = 0.0
    while x + D <= d[-1]:
        el = time_at(x + D) - time_at(x)
        best = el if best is None or el < best else best
        x += step
    return best


@pytest.mark.parametrize("seed", range(12))
def test_fastest_matches_brute_force(seed):
    rnd = random.Random(seed)
    n = rnd.randint(30, 140)
    t = [0.0]
    d = [0.0]
    for _ in range(n - 1):
        t.append(t[-1] + rnd.choice([1.0, 1.0, 2.0, 5.0]))
        d.append(d[-1] + rnd.choice([0.0, rnd.uniform(0.5, 9.0)]))
    bad = bad_prefix(t, d, 6.0 if seed % 2 else 99.0)
    for D in (50.0, 137.0, d[-1] * 0.6):
        r = fastest(t, d, D, bad)
        b = brute_fastest(t, d, D, bad)
        if b is None:
            assert r is None
        else:
            assert r["time"] == pytest.approx(b, rel=1e-12, abs=1e-9)
    if bad[-1] == 0:
        D = 100.0
        exact = fastest(t, d, D, bad)["time"]
        dense = dense_fastest(t, d, D, step=0.05)
        assert exact <= dense + 1e-9 and dense - exact < 0.05


def test_fastest_rejects_gps_spike():
    t = [float(i) for i in range(0, 501)]
    d = [3.0 * i for i in range(0, 501)]
    for i in range(250, 501):
        d[i] += 400.0  # teleport of 400 m in one second
    bad = bad_prefix(t, d, 12.0)
    r = fastest(t, d, 400.0, bad)
    assert r["time"] == pytest.approx(400.0 / 3.0)


def test_fastest_on_analyze_labels():
    t = [float(i) for i in range(0, 2002)]
    d = [i * 5.0 for i in range(0, 2002)]  # just over 10 km at 5 m/s
    r = analyze(act(t, d), S)
    by = {b["label"]: b["time"] for b in r["fastest"]}
    assert by["1 km"] == pytest.approx(200.0, rel=1e-6)
    assert by["10 km"] == pytest.approx(2000.0, rel=1e-6)
    assert by["Half marathon"] is None


def test_trimp_hand_case_male_and_female():
    # constant HR 155 with rest 50, max 190: x = 0.75
    t = [float(i) for i in range(0, 601)]
    hr = [155.0] * 601
    x = 0.75
    m = heart(t, hr, S)
    assert m["trimp"] == pytest.approx(10 * x * 0.64 * math.exp(1.92 * x), rel=1e-12)
    f = heart(t, hr, dict(S, trimp_sex="female"))
    assert f["trimp"] == pytest.approx(10 * x * 0.86 * math.exp(1.67 * x), rel=1e-12)
    assert m["avg"] == 155.0 and m["time"] == 600.0


def test_trimp_clamps_and_skips_gaps():
    t = [0.0, 60.0, 120.0, 400.0, 460.0]
    hr = [40.0, 250.0, 150.0, 150.0, None]
    m = heart(t, hr, S)
    expected = 0.0 + 1 * 1.0 * 0.64 * math.exp(1.92) + 1 * (100 / 140) * 0.64 * math.exp(1.92 * 100 / 140)
    assert m["trimp"] == pytest.approx(expected, rel=1e-12)  # 120 to 400 s gap is over 60 s: skipped
    assert m["time"] == 180.0


def test_zones_and_edwards():
    assert zone_bounds(dict(S, zone_method="max")) == pytest.approx([95, 114, 133, 152, 171])
    assert zone_bounds(S) == pytest.approx([120, 134, 148, 162, 176])
    t = [float(i) for i in range(0, 7)]
    hr = [100.0, 125.0, 140.0, 150.0, 170.0, 180.0, 180.0]
    m = heart(t, hr, S)
    assert m["zones"] == [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
    # Edwards weights from % of max: 52.6 %->1, 65.8->2, 73.7->3, 78.9->3, 89.5->4, 94.7->5
    assert m["edwards"] == pytest.approx((1 + 2 + 3 + 3 + 4 + 5) / 60.0)
    assert heart(t, [None] * 7, S) is None


def test_load_method_and_rpe_fallback():
    t = [float(i) for i in range(0, 601)]
    d = [3.0 * i for i in range(0, 601)]
    a = act(t, d, hr=[155.0] * 601)
    assert analyze(a, dict(S, load_method="edwards"))["load_source"] == "edwards"
    b = act(t, d)
    r = analyze(b, S, rpe=6)
    assert r["load_source"] == "rpe" and r["load"] == pytest.approx(60.0)
    assert analyze(b, S)["load"] is None


def test_power_constant_and_intervals():
    t = [float(i) for i in range(0, 121)]
    p = power(t, [200.0] * 121, S)
    assert p["avg"] == 200.0 and p["weighted"] == pytest.approx(200.0)
    assert p["meanmax"]["60"] == 200.0 and "300" not in p["meanmax"]
    alt = [400.0 if (i // 60) % 2 == 0 else 0.0 for i in range(0, 241)]
    q = power([float(i) for i in range(0, 241)], alt, S)
    assert q["weighted"] > q["avg"] and q["meanmax"]["30"] == 400.0
    assert power(t, [None] * 121, S) is None


def test_power_sample_and_hold_and_gap():
    t = [0.0, 10.0, 100.0]
    p = power(t, [100.0, 300.0, 50.0], S)
    # 0..9 -> 100, 10..70 -> 300, 71..99 -> 0 (gap over 60 s), 100 -> 50
    assert p["avg"] == pytest.approx((10 * 100 + 61 * 300 + 50) / 101)


def test_minetti_polynomial():
    assert minetti_cost(0.0) == 3.6
    assert minetti_cost(0.1) == pytest.approx(155.4e-5 - 30.4e-4 - 43.3e-3 + 46.3e-2 + 1.95 + 3.6)
    assert minetti_cost(-0.2) < minetti_cost(-0.1) < minetti_cost(0.0) < minetti_cost(0.1)
    assert minetti_cost(0.9) == minetti_cost(0.45)


def test_gap_flat_equals_speed_and_uphill_faster():
    t = [float(i) for i in range(0, 1001)]
    d = [3.0 * i for i in range(0, 1001)]
    mov = [False] + [True] * 1000
    flat = grade_adjusted(t, d, mov, [100.0] * 1001)
    assert flat["speed"] == pytest.approx(3.0)
    up = grade_adjusted(t, d, mov, [100.0 + 0.05 * x for x in d])
    assert up["speed"] > 3.0
    assert grade_adjusted(t, d, mov, None) is None
