"""Parity cases for physio, strength, logs, daily, routes and imports (used by make_vectors.py)."""

import math

from pulse import analysis as A, daily as D, imports as I, logs as L, physio as Ph, routes as Rt, strength as St
from pulse.example import generate
from pulse.util import parse_day

S = A.settings_with(None)
END = parse_day("2026-10-21")


def ik(d):
    """JSON object keys come back as strings; the Python functions take int day keys."""
    return {int(k): v for k, v in d.items()}


def rows_from_example():
    acts, daily = generate(END, 60)
    rows = []
    for k, a in enumerate(acts):
        r = A.analyze(a, None)
        rows.append({"id": "a%d" % k, "day": int(a["start"] // 86400), "sport": a["sport"], "name": a["name"],
                     "distance": r["distance"], "moving": r["moving"], "elapsed": r["elapsed"],
                     "gain": r["elevation"]["gain"], "load": r["load"], "kcal": r["calories"]["kcal"],
                     "gear": "g1" if a["sport"] == "run" else "g2",
                     "fastest": [[b["distance"], b["time"]] for b in r["fastest"]]})
    return acts, daily, rows


def cases():
    out = []
    add = lambda fn, args, py: out.append((fn, args, py))  # noqa: E731
    for hr, w, age, sex in ((150, 70, 40, "male"), (150, 60, 35, "female"), (60, 90, 70, "female")):
        add("keytelKcalPerMin", [hr, w, age, sex], Ph.keytel_kcal_per_min)
    for sp, v in (("run", 1.0), ("run", 2.5), ("run", 3.3), ("run", 7.0), ("ride", 3.0), ("ride", 6.0), ("ride", 9.5), ("other", 2.0), ("strength", 0)):
        add("metFor", [sp, v], Ph.met_for)
    for d, t in ((5000, 1200), (1609.344, 300), (21097.5, 5400), (42195, 12600), (0, 10)):
        add("vdot", [d, t], Ph.vdot)
    add("riegel", [1200, 5000, 42195, 1.06], Ph.riegel)
    add("bestVdot", [[[1000, 200], [1609.344, 330], [5000, 1150], [10000, None]]], Ph.best_vdot)
    add("vo2maxUth", [190, 50], Ph.vo2max_uth)
    for v, sx in ((60, "male"), (46.5, "male"), (40, "male"), (30, "female"), (10, "female"), (15.4, "female"), (None, "male")):
        add("fitnessAge", [v, sx], Ph.fitness_age)
    add("powerLoad", [250, 3600, 250], Ph.power_load)
    add("powerHrRatio", [[[50 + k, 40 + k * 0.9] for k in range(12)], 10], Ph.power_hr_ratio)
    add("powerHrRatio", [[[50, 40]], 10], Ph.power_hr_ratio)
    for T in (0, 10, 100, 500, 2000):
        add("dayIndex", [T], Ph.day_index)
    add("summaryTrimp", [150, 60, S], Ph.summary_trimp)
    t = [float(i) for i in range(0, 301)]
    hr = [120.0 + (i % 60) for i in range(301)]
    pw = [100.0 + 2 * (i % 150) for i in range(301)]
    add("luciaTrimp", [t, hr, 140, 165, S], Ph.lucia_trimp)
    add("powerZoneTime", [t, pw, 250, S], Ph.power_zone_time)
    add("calories", [t, hr, "run", 300.0, 3.0, S], Ph.calories)
    add("calories", [t, [None] * 301, "ride", 300.0, 7.0, S], Ph.calories)
    # strength
    for w, r in ((100, 1), (100, 5), (100, 10), (80, 36), (80, 37), (None, 5)):
        add("epley", [w, r], St.epley)
        add("brzycki", [w, r], St.brzycki)
    sessions = [{"date": 100, "name": "A", "sets": [{"exercise": "Squat", "reps": 5, "load": 100}, {"exercise": "Squat", "reps": 3, "load": 110},
                                                       {"exercise": "Bench", "reps": 8, "load": 60}, {"exercise": "", "reps": 5, "load": 10}]},
                {"date": 104, "name": "B", "sets": [{"exercise": "Squat", "reps": 1, "load": 125}, {"exercise": "Bench", "reps": 10, "load": 62.5}]}]
    add("sessionStats", [sessions[0]], St.session_stats)
    add("strengthRecords", [sessions], St.records)
    # logs on the example athlete
    acts, daily, rows = rows_from_example()
    for g in ({"metric": "distance", "period": "week", "target": 40000, "sport": "run"},
              {"metric": "time", "period": "month", "target": 20 * 3600, "sport": "all"},
              {"metric": "elevation", "period": "year", "target": 50000},
              {"metric": "sessions", "period": "week", "target": 5}):
        add("goalProgress", [rows, g, END], L.goal_progress)
    add("totals", [rows, END - 27, END, "all"], L.totals)
    add("periods", [rows, "week", END, 6], L.periods)
    add("periods", [rows, "month", END, 3], L.periods)
    add("weeklyBand", [rows, END], L.weekly_band)
    add("yearReview", [rows, 2026], L.year_review)
    add("longestStreak", [[1, 2, 3, 5, 6, 9, 10, 11, 12, 12]], L.longest_streak)
    add("gearTotals", [[{"id": "g1", "name": "Shoe", "kind": "shoe", "start_km": 50, "retire_km": 400},
                        {"id": "g2", "name": "Bike", "kind": "bike", "start_km": 0, "retire_km": None}], rows], L.gear_totals)
    add("weightTrend", [[{"date": 100 + k, "kg": 80 - 0.05 * k + (0.3 if k % 3 else -0.2)} for k in range(0, 45, 2)]], L.weight_trend)
    add("bpSummary", [[{"date": 100 + k, "sys": 120 + k % 5, "dia": 80 - k % 3} for k in range(40)], 139], L.bp_summary)
    for starts, day in (([1000, 1029, 1057], 1060), ([1000, 1029, 1057], 1080), ([1000], 1013), ([1000], 1100), ([], 5), ([1000, 1100], 1110)):
        add("cyclePhase", [starts, day, 28], L.cycle_phase)
    answers = {str(END - k): {"Alcohol": k % 4 == 0, "Late meal": k % 3 == 0} for k in range(0, 80)}
    metric = {str(r["date"]): math.log(r["rmssd"]) for r in daily if r["rmssd"]}
    for tag in ("Alcohol", "Late meal", "Missing"):
        add("association", [answers, metric, END, tag, 90, 300, 12345],
            lambda a, m, d, tg, w, p, sd: L.association(ik(a), ik(m), d, tg, w, p, sd))
    from pulse import load_series, readiness, daily_loads
    loads = daily_loads([(r["day"], r["load"]) for r in rows])
    series = load_series(loads, END - 59, END)
    rd = readiness(daily, END, S, loads)
    add("insights", [rows, rd, series, END, daily], L.insights)
    for st in ("clear", "one_off", "several_off", "none"):
        add("suggest", [rows, dict(rd, state=st), series, END], L.suggest)
    add("suggest", [[], None, None, END], L.suggest)
    # daily
    hrm = []
    base = (END) * 1440 + 300  # 05:00 UTC
    for k in range(0, 900):
        m = base + k
        v = 52 + (60 if 120 <= k < 170 else 0) + (25 if 400 <= k < 430 else 0) + (k % 7)
        if k % 50 != 49:
            hrm.append([m, float(v), -18000.0])
    busy = [[(base + 400) * 60, (base + 432) * 60]]
    add("overnightRhr", [hrm, base * 60, (base + 100) * 60], D.overnight_rhr)
    add("stress", [hrm, END, 52.0, 190.0, busy, [[END, 9, 25.0], [END, 10, 60.0]], [math.log(45.0), 0.2]], D.stress)
    add("detectWorkouts", [hrm, 52.0, 190.0, busy, 0.30, 10, 3], D.detect_workouts)
    add("dayTrimp", [hrm, END, S], D.day_trimp)
    for need, wake in ((8.0, 390), (7.5, 30), (9.2, 1430)):
        add("sleepPlan", [need, wake, 15.0], D.sleep_plan)
    srows = [{"date": 100 + k, "sleep": 7 + (k % 3) * 0.3, "in_bed": 8.0, "bed_min": 650 + (k % 4) * 10, "wake_min": 390 + (k % 2) * 15,
              "resp": 14 + (k % 5) * 0.2, "steps": 8000 + k * 10} for k in range(70)]
    srows[69]["resp"] = 18.0
    add("efficiency", [srows[3]], D.efficiency)
    add("consistency", [srows, 169, 4], D.consistency)
    add("vital", [srows, 169, "resp", 60, 14], D.vital)
    add("vital", [srows, 120, "resp", 60, 14], D.vital)
    # whole-number baseline with MAD = 0 (blood oxygen): the mean absolute deviation fallback
    spo = [{"date": 300 + k, "spo2": 97.0 if k % 5 else 96.0} for k in range(61)]
    spo[60]["spo2"] = 92.0
    add("vital", [spo, 360, "spo2", 60, 14], D.vital)
    flat = [{"date": 300 + k, "spo2": 97.0} for k in range(61)]
    add("vital", [flat, 360, "spo2", 60, 14], D.vital)
    add("stepsSummary", [srows, 169, 7], D.steps_summary)
    # routes
    a0, a1 = acts[0], acts[1]
    d0 = A.cumdist(a0)
    add("@signature", [a0], lambda a: Rt.signature(a, A.cumdist(a)))
    sigs = [["a%d" % k, Rt.signature(a, A.cumdist(a))] for k, a in enumerate(acts[:20])]
    add("groupRoutes", [sigs], Rt.group_routes)
    small = {k: (v[:40] if isinstance(v, list) else v) for k, v in a0.items()}
    add("toGpx", [small, "Easy <loop> & co"], Rt.to_gpx)
    seg = Rt.make_segment(a0, 100, 400, "Hill")
    add("makeSegment", [a0, 100, 400, "Hill"], Rt.make_segment)
    for a in acts[:4]:
        add("matchSegment", [seg, a], Rt.match_segment)
    dem = [[41.0 + i * 0.0004, -40.0 - 0.033 + j * 0.0004, 100.0 + i + j] for i in range(-30, 30) for j in range(-30, 30)]
    tiny = {k: (v[:200] if isinstance(v, list) else v) for k, v in a0.items()}
    add("correctElevation", [dem, tiny, 150.0, 4], Rt.correct_elevation)
    add("parseDem", ["lat,lon,ele\n41.0,-40.0,100\n41.001\t-40.001\t101.5\n\n"], Rt.parse_dem)
    add("parseDem", ["41.0,-40.0\n"], Rt.parse_dem)
    add("parseDem", ["lat,lon,ele\n95,1,1\n"], Rt.parse_dem)
    add("equalize", [[0, 1, 1, 2, 5, 0, 5, 9]], Rt.equalize)
    add("equalize", [[0, 0]], Rt.equalize)
    # imports
    csvt = 'a,b,c\n1,"two, with comma","line\nbreak"\r\n"q""uote",,3\n\n'
    add("parseCsv", [csvt], I.parse_csv)
    strava = ("Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Filename,Activity Gear,Moving Time,Distance\n"
              '101,"Jan 2, 2026, 7:00:00 AM",Morning Run,Run,"desc, with comma",1800,5.01,activities/101.fit.gz,Shoe A,1750,5010.0\n'
              '102,"Jan 3, 2026, 7:00:00 AM",Manual swim,Swim,,2400,1.5,,,2400,1500.0\n'
              '103,"Jan 4, 2026, 7:00:00 AM",Gym,Weight Training,,3600,0,,,3600,0\n')
    add("stravaIndex", [strava], I.strava_index)
    add("stravaIndex", ["x,y\n1,2\n"], I.strava_index)
    cyc = ("Cycle start time,Cycle end time,Cycle timezone,Recovery score %,Resting heart rate (bpm),Heart rate variability (ms),Skin temp (celsius),"
           "Blood oxygen %,Day Strain,Sleep onset,Wake onset,Respiratory rate (rpm),Asleep duration (min),In bed duration (min),"
           "Light sleep duration (min),Deep (SWS) duration (min),REM duration (min)\n"
           "2026-01-01 22:30:00,2026-01-02 22:00:00,UTC-05:00,66,52,61,33.4,96.5,12.1,2026-01-01 22:45:00,2026-01-02 06:40:00,14.2,430,470,220,90,120\n"
           "2026-01-02 22:00:00,,UTC-05:00,,50,,,,,2026-01-03 00:30:00,2026-01-03 07:10:00,,,,,,\n")
    add("whoopCycles", [cyc], I.whoop_cycles)
    add("whoopCycles", ["Cycle start time,Resting heart rate (bpm),Heart rate variability (ms),Wake onset,Asleep duration (min),Blood oxygen %\n"
                        "2026-03-04 22:00:00,-50,0,2026-03-05 06:30:00,-450,140\n"], I.whoop_cycles)
    add("whoopNaps", ["Sleep onset,Wake onset,Nap,Asleep duration (min)\n2026-01-02 14:00:00,2026-01-02 14:30:00,true,25\n"
                      "2026-01-02 23:00:00,2026-01-03 07:00:00,false,420\n"], lambda t: {str(k): v for k, v in I.whoop_naps(t).items()})
    add("whoopWorkouts", ["Workout start time,Workout end time,Duration (min),Activity name,Activity Strain,Energy burned (cal),Max HR (bpm),"
                          "Average HR (bpm),Distance (meters),Altitude gain (meters)\n2026-01-02 07:00:00,2026-01-02 07:45:00,45,Running,10.2,520,171,148,8100,55\n"
                          "2026-01-03 18:00:00,,60,Weightlifting,6,300,140,110,,\n,,,,,,,,,\n"], I.whoop_workouts)
    add("whoopJournal", ["Cycle start time,Cycle end time,Cycle timezone,Question text,Answered yes,Notes\n"
                         "2026-01-01 22:30:00,,,Have any alcoholic drinks?,true,\n2026-01-01 22:30:00,,,Read before bed?,false,\n"],
        lambda t: {str(k): v for k, v in I.whoop_journal(t).items()})
    add("whoopJournal", ["a,b\n1,2\n"], I.whoop_journal)
    add("analyzeSummary", [{"sport": "run", "duration": 2700, "distance": 8100, "avg_hr": 148, "kcal": 520, "gain": 55}, None, None], A.analyze_summary)
    add("analyzeSummary", [{"sport": "strength", "duration": 3600}, None, 6], A.analyze_summary)
    add("analyzeSummary", [{"sport": "ride", "duration": 3600, "distance": 25000}, None, None], A.analyze_summary)
    return out
