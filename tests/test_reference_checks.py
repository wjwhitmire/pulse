"""Hand checks against published definitions, written independently of the code under test,
plus regressions for bugs found in the full function pass (2026-10-23)."""

import math
import statistics

from pulse.daily import vital
from pulse.imports import whoop_cycles
from pulse.load import load_series
from pulse.recovery import readiness, rmssd
from pulse.util import parse_day, parse_time


def close(a, b, tol=1e-9):
    return abs(a - b) <= tol * max(1.0, abs(b))


def test_fitness_fatigue_form_closed_forms():
    # F(t) = F(t-1) + (L - F(t-1)) k, k = 1 - e^(-1/tau): constant load L gives L (1 - (1 - k)^(n + 1)).
    s = load_series({z: 100.0 for z in range(61)}, 0, 60, 42.0, 7.0)
    kf, kd = 1 - math.exp(-1 / 42), 1 - math.exp(-1 / 7)
    assert close(s["fitness"][60], 100 * (1 - (1 - kf) ** 61))
    assert close(s["fatigue"][60], 100 * (1 - (1 - kd) ** 61))
    # Form on a day is yesterday's fitness minus yesterday's fatigue (the balance carried into the day).
    assert close(s["form"][60], 100 * (1 - (1 - kf) ** 60) - 100 * (1 - (1 - kd) ** 60))
    # One impulse decays as Banister's e^(-t/tau), scaled by k.
    s2 = load_series({0: 300.0}, 0, 30, 42.0, 7.0)
    assert close(s2["fitness"][30], kf * 300 * math.exp(-30 / 42))
    assert close(s2["fatigue"][30], kd * 300 * math.exp(-30 / 7))
    # Uncoupled ratio: last 7 days over the 21 days before them.
    s3 = load_series({z: (50.0 if z < 21 else 80.0) for z in range(28)}, 0, 27)
    assert close(s3["ratio"][27], 80 / 50)


def test_rmssd_task_force_definition():
    rr = [800, 810, 790, 805, 795, 820, 780, 800, 815, 805, 790, 800, 810, 795, 805, 790, 800, 810, 790, 805, 800, 815]
    d = [(rr[i] - rr[i - 1]) ** 2 for i in range(1, len(rr))]
    assert close(rmssd(rr), math.sqrt(sum(d) / len(d)))
    # an artefact removes the two differences that touch it, nothing else
    rr2 = rr + rr[:6]
    rr2[10] = 2500
    d2 = [(rr2[i] - rr2[i - 1]) ** 2 for i in range(1, len(rr2)) if i not in (10, 11)]
    assert close(rmssd(rr2), math.sqrt(sum(d2) / len(d2)))


def test_hrv_baseline_is_ln_mean_plus_minus_half_sd():
    vals = {z: 50 + 10 * math.sin(z) for z in range(1000, 1061)}
    daily = [{"date": z, "rmssd": v} for z, v in vals.items()]
    s = {"sleep_base": 8.0, "sleep_debt_share": 0.1, "sleep_load_per100": 0.0}
    r = readiness(daily, 1060, s)
    base = [math.log(vals[z]) for z in range(1000, 1060)]
    mu, sd = statistics.mean(base), statistics.stdev(base)
    assert close(r["hrv"]["mean"], mu) and close(r["hrv"]["sd"], sd)
    assert close(r["hrv"]["lo"], mu - 0.5 * sd) and close(r["hrv"]["hi"], mu + 0.5 * sd)
    assert close(r["hrv"]["roll"], statistics.mean(math.log(vals[z]) for z in range(1054, 1061)))


def test_dates_that_do_not_exist_are_refused():
    assert parse_day("2026-02-30") is None and parse_day("2026-04-31") is None
    assert parse_day("2024-02-29") is not None and parse_day("2026-02-29") is None
    assert parse_time("2026-02-30T07:00:00Z") is None
    assert parse_time("2024-02-29T07:00:00Z") == parse_day("2024-02-29") * 86400 + 7 * 3600


def test_vital_flags_a_drop_when_most_of_the_baseline_is_one_value():
    rows = [{"date": 300 + k, "spo2": 97.0 if k % 5 else 96.0} for k in range(60)] + [{"date": 360, "spo2": 92.0}]
    v = vital(rows, 360, "spo2")
    assert v["flag"] is True and v["rsd"] > 0
    # 1.253314 x mean absolute deviation from the median (12 of 60 values are 1 below it)
    assert close(v["rsd"], 1.253314 * 12 / 60)
    # a baseline of one repeated value has no spread: said plainly, never z = 0
    flat = [{"date": 300 + k, "spo2": 97.0} for k in range(60)] + [{"date": 360, "spo2": 92.0}]
    f = vital(flat, 360, "spo2")
    assert f["no_variation"] is True and f["z"] is None and f["flag"] is False


def test_whoop_values_outside_plausible_ranges_are_dropped():
    rows = whoop_cycles("Cycle start time,Resting heart rate (bpm),Heart rate variability (ms),Wake onset,Asleep duration (min)\n"
                        "2026-03-04 22:00:00,-50,0,2026-03-05 06:30:00,-450\n2026-03-05 22:00:00,52,61,2026-03-06 06:30:00,450\n")
    assert rows[0]["rhr"] is None and rows[0]["rmssd"] is None and rows[0]["sleep"] is None
    assert rows[1]["rhr"] == 52 and rows[1]["rmssd"] == 61 and rows[1]["sleep"] == 7.5


def test_cli_units_and_bad_dates(tmp_path, capsys):
    from pulse.cli import main
    from test_gpx import GPX
    f = tmp_path / "a.gpx"
    f.write_text(GPX)
    assert main(["activity", str(f), "--units", "mi"]) == 0
    assert " mi, moving" in capsys.readouterr().out
    assert main(["example", "--end", "2026-02-30"]) == 2
    assert "real date" in capsys.readouterr().err
    d = tmp_path / "d.csv"
    d.write_text("date,hrv_ms,resting_hr,sleep_hours\n2026-01-01,50,50,7\n")
    assert main(["readiness", str(d), "--day", "2026-13-01"]) == 2
