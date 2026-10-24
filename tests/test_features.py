import math

import pytest

from pulse import PulseError, analyze, parse_gpx, settings_with
from pulse import daily as D, imports as I, logs as L, physio as Ph, routes as Rt, strength as St
from pulse.analysis import analyze_summary, cumdist
from pulse.example import generate
from pulse.util import parse_day

S = settings_with(None)
K = math.pi / 180 * 6371008.8
END = parse_day("2026-10-21")


def line_act(n=600, v=3.0, start=1767225600.0, heading=0.0):
    t = [start + i for i in range(n)]
    lat = [41.0 + v * i * math.cos(heading) / K for i in range(n)]
    lon = [-40.0 + v * i * math.sin(heading) / (K * math.cos(math.radians(41.0))) for i in range(n)]
    return {"source": "test", "name": "Line", "sport": "run", "start": start, "t": t, "lat": lat, "lon": lon,
            "ele": [100.0] * n, "hr": [150.0] * n, "cad": [None] * n, "pwr": [None] * n, "dist": [None] * n,
            "laps": [], "session": None, "pauses": [], "rr": [], "warnings": []}


# ---------------------------------------------------------------- physio

def test_keytel_hand_values():
    assert Ph.keytel_kcal_per_min(150, 70, 40, "male") == pytest.approx((-55.0969 + 0.6309 * 150 + 0.1988 * 70 + 0.2017 * 40) / 4.184)
    assert Ph.keytel_kcal_per_min(150, 60, 35, "female") == pytest.approx((-20.4022 + 0.4472 * 150 - 0.1263 * 60 + 0.074 * 35) / 4.184)
    assert Ph.keytel_kcal_per_min(40, 50, 20, "male") == 0.0  # negative results clamp to zero


def test_met_table():
    assert Ph.met_for("run", 6.0 / 2.2369362920544) == pytest.approx(9.8)
    assert Ph.met_for("run", 5.5 / 2.2369362920544) == pytest.approx(9.0 + 0.3 / 0.8 * 0.8)
    assert Ph.met_for("run", 1.0) == 3.5
    assert Ph.met_for("ride", 13.0 / 2.2369362920544) == 8.0
    assert Ph.met_for("other", 1.0) == 5.0


def test_calories_keytel_and_met_fallback():
    t = [float(i) for i in range(0, 601)]
    c = Ph.calories(t, [150.0] * 601, "run", 600.0, 3.0, S)
    assert c["method"] == "keytel" and c["kcal"] == pytest.approx(10 * Ph.keytel_kcal_per_min(150, 70, 40, "male"))
    m = Ph.calories(t, [None] * 601, "ride", 3600.0, 13.0 / 2.2369362920544, S)
    assert m["method"] == "met" and m["kcal"] == pytest.approx(8.0 * 70)


def test_vdot_and_riegel():
    assert Ph.vdot(5000, 20 * 60) == pytest.approx(49.8, abs=0.1)   # Daniels' table: 5 km 20:00 is VDOT 49.8
    assert Ph.vdot(42195, 3 * 3600) == pytest.approx(53.5, abs=0.2)
    assert Ph.riegel(1200, 5000, 10000) == pytest.approx(1200 * 2 ** 1.06)
    b = Ph.best_vdot([(1000, 180), (5000, 1200), (10000, 2700)])
    assert b["distance"] == 5000 and b["predictions"][0]["time"] == pytest.approx(1200)


def test_uth_and_fitness_age():
    assert Ph.vo2max_uth(190, 50) == pytest.approx(15.3 * 3.8)
    assert Ph.fitness_age(46.5, "male") == 25.0
    assert Ph.fitness_age(37.5, "male") == pytest.approx(40.0)
    assert Ph.fitness_age(80, "male") == 20.0 and Ph.fitness_age(5, "female") == 90.0
    assert Ph.fitness_age(None, "male") is None


def test_power_load_zones_and_lucia():
    assert Ph.power_load(250, 3600, 250) == pytest.approx(100.0)
    t = [float(i) for i in range(0, 101)]
    z = Ph.power_zone_time(t, [260.0] * 101, 250, S)
    assert z[3] == 101.0 and sum(z) == 101.0
    hr = [130.0] * 50 + [170.0] * 51
    assert Ph.lucia_trimp(t, hr, 140, 165, S) == pytest.approx((50 * 1 + 50 * 3) / 60)
    assert Ph.lucia_trimp(t, hr, 0, 165, S) is None


def test_power_hr_ratio_and_day_index():
    pairs = [(2.0 * h, h) for h in range(10, 20)]
    assert Ph.power_hr_ratio(pairs) == pytest.approx(2.0)
    assert Ph.power_hr_ratio(pairs[:9]) is None
    assert Ph.day_index(0) == 0.0 and Ph.day_index(1000) == pytest.approx(10.0) and Ph.day_index(5000) == 10.0
    assert 0 < Ph.day_index(50) < Ph.day_index(100) < 10


def test_analyze_new_fields():
    a = line_act()
    r = analyze(a, dict(S, threshold_speed=2.9))
    assert r["calories"]["method"] == "keytel"
    assert r["pace_zones"][4] == pytest.approx(599, abs=1)  # 3.0 m/s is 103 % of a 2.9 m/s threshold
    assert r["max_speed"] == pytest.approx(3.0, rel=1e-6)
    a["laps"] = [{"start": a["t"][0]}, {"start": a["t"][300]}]
    lt = analyze(a, S)["lap_table"]
    assert [round(x["elapsed"]) for x in lt] == [300, 299] and lt[0]["distance"] == pytest.approx(900, rel=1e-6)


def test_analyze_summary_only():
    r = analyze_summary({"sport": "run", "duration": 3600, "distance": 10000, "avg_hr": 155})
    assert r["load_source"] == "approx" and r["load"] == pytest.approx(Ph.summary_trimp(155, 60, S))
    r = analyze_summary({"sport": "strength", "duration": 1800}, None, 5)
    assert r["load_source"] == "rpe" and r["load"] == 150.0 and r["kcal"] == pytest.approx(3.5 * 70 * 0.5)


# ---------------------------------------------------------------- strength

def test_one_rep_max_formulas():
    assert St.epley(100, 1) == 100 and St.epley(100, 10) == pytest.approx(133.333, rel=1e-4)
    assert St.brzycki(100, 10) == pytest.approx(100 * 36 / 27) and St.brzycki(100, 37) is None


def test_records_and_volume():
    ses = [{"date": 1, "sets": [{"exercise": "Squat", "reps": 5, "load": 100}, {"exercise": "Squat", "reps": 5, "load": 105}]},
           {"date": 8, "sets": [{"exercise": "Squat", "reps": 1, "load": 130}, {"exercise": " ", "reps": 3, "load": 1}]}]
    assert St.session_stats(ses[0])["volume"] == 1025.0
    r = St.records(ses)["Squat"]
    assert r["e1rm"] == pytest.approx(130.0) and r["e1rm_date"] == 8
    assert r["set_volume"] == 525.0 and r["set_volume_date"] == 1
    assert r["trend"] == [[1, pytest.approx(122.5)], [8, 130.0]]


# ---------------------------------------------------------------- logs

def rows():
    acts, _ = generate(END, 60)
    out = []
    for k, a in enumerate(acts):
        r = analyze(a)
        out.append({"id": f"a{k}", "day": int(a["start"] // 86400), "sport": a["sport"], "name": a["name"], "distance": r["distance"],
                    "moving": r["moving"], "elapsed": r["elapsed"], "gain": r["elevation"]["gain"], "load": r["load"],
                    "kcal": r["calories"]["kcal"], "gear": "s" if a["sport"] == "run" else None,
                    "fastest": [[b["distance"], b["time"]] for b in r["fastest"]]})
    return out


R = rows()


def test_periods_and_goals():
    a, b = L.period_range("week", END)
    assert (a + 3) % 7 == 0 and b - a == 6  # Monday to Sunday
    assert L.period_range("month", parse_day("2026-02-10")) == (parse_day("2026-02-01"), parse_day("2026-02-28"))
    g = L.goal_progress(R, {"metric": "sessions", "period": "week", "target": 4}, END)
    assert g["value"] == sum(1 for r in R if a <= r["day"] <= b)
    assert g["days_left"] == b - END
    m = L.periods(R, "month", END, 2)
    assert len(m) == 2 and m[-1]["end"] >= END


def test_weekly_band_year_review_and_streak():
    wb = L.weekly_band(R, END)
    assert wb["lo"] <= wb["mean"] <= wb["hi"] and len(wb["previous"]) == 4
    y = L.year_review(R, 2026)
    assert y["totals"]["count"] == len(R) and sum(y["weekdays"]) == len(R)
    assert y["longest"] == max(R, key=lambda r: r["distance"])["id"]
    assert L.longest_streak([1, 2, 3, 7, 8]) == 3 and L.longest_streak([]) == 0


def test_gear_retire_alert():
    g = L.gear_totals([{"id": "s", "name": "Shoe", "start_km": 0, "retire_km": 50}, {"id": "x", "name": "Spare", "retire_km": 500}], R)
    assert g[0]["retire"] and g[0]["remaining"] < 0 and not g[1]["retire"] and g[1]["count"] == 0


def test_body_and_cycle():
    w = L.weight_trend([{"date": d, "kg": 80.0 - 0.1 * d} for d in range(0, 40)])
    assert w["series"][-1][2] == pytest.approx(80.0 - 0.1 * 36)  # mean of days 33..39
    assert w["change30"] == pytest.approx(-3.0)
    assert L.bp_summary([{"date": 5, "sys": 120, "dia": 80}, {"date": 9, "sys": 130, "dia": 84}], 10)["d7"] == [125, 82, 2]
    c = L.cycle_phase([100, 128, 156], 160)
    assert c["cycle_day"] == 5 and c["phase"] == "menstrual" and c["length"] == 28 and c["next_start"] == 184
    assert L.cycle_phase([100], 113)["phase"] == "ovulatory"
    assert L.cycle_phase([100], 120)["phase"] == "luteal"
    assert L.cycle_phase([100], 200)["phase"] == "unknown"
    assert L.cycle_phase([], 5) is None


def test_association_permutation():
    ans = {z: {"late": z % 2 == 0} for z in range(1, 41)}
    metric = {z + 1: (3.5 if z % 2 == 0 else 4.0) + 0.01 * (z % 5) for z in range(1, 41)}
    r = L.association(ans, metric, 40, "late", window=60, perms=500)
    assert r["n_yes"] == 20 and r["diff"] == pytest.approx(-0.5, abs=0.02) and r["p"] < 0.01
    few = L.association({1: {"x": True}}, {2: 1.0}, 5, "x")
    assert few["p"] is None


def test_insights_and_suggestions():
    from pulse import daily_loads, load_series, readiness
    _, daily = generate(END, 60)
    loads = daily_loads([(r["day"], r["load"]) for r in R])
    ser = load_series(loads, END - 59, END)
    rd = readiness(daily, END, S, loads)
    ins = L.insights(R, rd, ser, END, daily)
    keys = [x["key"] for x in ins]
    assert "hrv" in keys and "load" in keys and "form" in keys
    assert all(x["numbers"] for x in ins)
    s = L.suggest(R, dict(rd, state="several_off"), ser, END)
    assert s["intent"] == "Recover" and "two or more readiness inputs are off their baselines" in s["reason"]
    assert L.suggest([], None, None, END)["intent"] == "Build"


# ---------------------------------------------------------------- daily

def test_sleep_measures():
    assert D.efficiency({"sleep": 7.0, "in_bed": 8.0}) == 0.875
    rows_ = [{"date": z, "bed_min": 660.0, "wake_min": 390.0} for z in range(1, 6)]
    assert D.consistency(rows_, 5)["score"] == 100.0
    p = D.sleep_plan(8.0, 6 * 60 + 30)
    assert p["bedtime"] == "22:15" and p["window_start"] == "06:00"
    assert D.sleep_plan(7.0, 30)["bedtime"] == "17:15"


def test_vital_robust_flag():
    rows_ = [{"date": z, "resp": 14.0 + (z % 3) * 0.2} for z in range(0, 70)]
    rows_[69]["resp"] = 17.0
    v = D.vital(rows_, 69, "resp")
    assert v["median"] == pytest.approx(14.2) and v["flag"]
    assert D.vital(rows_, 10, "resp") is None


def test_minute_hr_measures():
    base = 1000 * 1440
    hr = [[base + k, 50.0 + (60 if 100 <= k < 130 else 0) + (k % 3), 0.0] for k in range(600)]
    assert D.overnight_rhr(hr, base * 60, (base + 60) * 60) == pytest.approx(50.8, abs=0.2)
    w = D.detect_workouts(hr, 50, 190)
    assert len(w) == 1 and w[0]["minutes"] == 30
    assert D.detect_workouts(hr, 50, 190, busy=[[(base + 90) * 60, (base + 140) * 60]]) == []
    st = D.stress(hr, 1000, 50.0, 190.0)
    assert [x["level"] for x in st if x["hour"] == 1] == [1]  # minutes 100..129 fall in hour 1
    assert D.day_trimp(hr, 1000, S)["trimp"] > 0


# ---------------------------------------------------------------- routes

def test_signature_and_grouping():
    a, b = line_act(), line_act(start=1767312000.0)
    c = line_act(heading=math.pi / 2)
    sa, sb, sc = (Rt.signature(x, cumdist(x)) for x in (a, b, c))
    assert Rt.same_route(sa, sb) and not Rt.same_route(sa, sc)
    assert Rt.group_routes([("a", sa), ("b", sb), ("c", sc), ("d", None)]) == [["a", "b"], ["c"]]


def test_gpx_export_round_trip():
    a = line_act(n=30)
    a["name"] = "Loop <A> & B"
    (back,) = parse_gpx(Rt.to_gpx(a).encode())
    assert back["name"] == "Loop <A> & B" and back["t"] == a["t"] and back["hr"] == a["hr"]
    assert back["lat"][5] == pytest.approx(a["lat"][5], abs=1e-7)


def test_segment_match():
    a = line_act(n=400)
    seg = Rt.make_segment(a, 100, 200, "Straight")
    assert seg["length"] == pytest.approx(300.0, rel=1e-3)
    e = Rt.match_segment(seg, line_act(n=400, v=3.0, start=1767400000.0))
    assert len(e) == 1 and e[0]["elapsed"] == pytest.approx(100.0, abs=1.0)
    rev = line_act(n=400)
    rev["lat"] = rev["lat"][::-1]
    assert Rt.match_segment(seg, rev) == []  # wrong direction
    with pytest.raises(PulseError):
        Rt.make_segment(a, 10, 11)


def test_dem_correction_and_parse():
    pts = Rt.parse_dem("lat,lon,ele\n41.0,-40.0,10\n41.0005,-40.0,20\n")
    a = line_act(n=3, v=0.0)
    out = Rt.correct_elevation(pts, a)
    assert out == [10.0, 10.0, 10.0]
    far = line_act(n=2)
    far["lat"] = [42.0, 42.0]
    assert Rt.correct_elevation(pts, far) == [100.0, 100.0]
    with pytest.raises(PulseError):
        Rt.parse_dem("lat,lon\n1,2\n")


def test_equalize():
    assert Rt.equalize([0, 1, 1, 2, 8]) == [0.0, 0.5, 0.5, 0.75, 1.0]


# ---------------------------------------------------------------- imports

def test_csv_parser_rfc4180():
    rows_ = I.parse_csv('a,b\n"x, y","he said ""hi""\nthen left"\r\n,\n3,4')
    assert rows_ == [["a", "b"], ["x, y", 'he said "hi"\nthen left'], ["3", "4"]]


def test_strava_index():
    txt = ("Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Activity Gear,Distance\n"
           "1,d,Run one,Trail Run,1800,5.0,activities/1.FIT.gz,Shoe,5000.0\n2,d,Swim,Swim,1200,1.0,,,1000.0\n")
    ix = I.strava_index(txt)
    assert ix["files"]["activities/1.fit.gz"]["sport"] == "run" and ix["files"]["activities/1.fit.gz"]["gear"] == "Shoe"
    assert ix["manual"][0]["distance"] == 1000.0 and ix["manual"][0]["elapsed"] == 1200.0
    with pytest.raises(PulseError):
        I.strava_index("a,b\n1,2\n")


def test_whoop_imports():
    cyc = ("Cycle start time,Resting heart rate (bpm),Heart rate variability (ms),Sleep onset,Wake onset,Asleep duration (min),"
           "Recovery score %\n2026-01-01 22:30:00,52,61,2026-01-01 22:45:00,2026-01-02 06:40:00,430,66\n")
    (d,) = I.whoop_cycles(cyc)
    assert d["date"] == parse_day("2026-01-02") and d["rmssd"] == 61 and d["sleep"] == pytest.approx(430 / 60)
    assert d["bed_min"] == 22 * 60 + 45 - 720 and d["wake_min"] == 400
    assert 66 not in d.values() and 66.0 not in d.values()  # the service's own score is not imported
    w = I.whoop_workouts("Workout start time,Duration (min),Activity name,Average HR (bpm)\n2026-01-02 07:00:00,45,Cycling,140\n")
    assert w[0]["sport"] == "ride" and w[0]["duration"] == 2700
    j = I.whoop_journal("Cycle start time,Question text,Answered yes\n2026-01-01 22:30:00,Caffeine?,TRUE\n")
    assert j == {parse_day("2026-01-01"): {"Caffeine?": True}}
    n = I.whoop_naps("Sleep onset,Nap,Asleep duration (min)\n2026-01-02 14:00:00,true,30\n")
    assert n == {parse_day("2026-01-02"): 0.5}
