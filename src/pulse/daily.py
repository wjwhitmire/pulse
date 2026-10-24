"""Whole-day measures: sleep efficiency and consistency, vitals against a robust baseline,
overnight resting HR from minute heart rate, daytime stress (descriptive), workout detection,
the day load index and a sleep planner.

Minute heart rate is a list of [UTC minute, mean bpm, local offset s] (see recovery.health_extras).
"""

from __future__ import annotations

import math

from .physio import day_index
from .util import mean, sd


def local_day_of(minute, offset):
    return int(math.floor((minute * 60 + offset) / 86400))


def efficiency(row):
    if row.get("sleep") is None or not row.get("in_bed"):
        return None
    return min(1.0, row["sleep"] / row["in_bed"])


def consistency(rows, day, nights=4):
    """Spread of bed and wake times over the last `nights` nights with both. Score =
    100 x max(0, 1 - (SD bed + SD wake) / 120 min). 100 = identical times every night."""
    sel = [r for r in rows if day - nights < r["date"] <= day and r.get("bed_min") is not None and r.get("wake_min") is not None]
    if len(sel) < 3:
        return None
    sb = sd([r["bed_min"] for r in sel])
    sw = sd([r["wake_min"] for r in sel])
    return {"nights": len(sel), "sd_bed": sb, "sd_wake": sw, "score": 100.0 * max(0.0, 1.0 - (sb + sw) / 120.0)}


def _median(xs):
    v = sorted(xs)
    n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2.0


def vital(rows, day, key, base_days=60, min_base=14):
    """Value on `day` against the median of the previous 60 days, with a robust SD of
    1.4826 x median absolute deviation. Flag beyond 2 robust SDs. When more than half the baseline
    equals the median (MAD = 0, common for whole-number blood oxygen) the scale falls back to
    1.253314 x mean absolute deviation (Iglewicz and Hoaglin's modified z-score)."""
    by = {r["date"]: r for r in rows}
    cur = by.get(day, {}).get(key)
    base = [by[z][key] for z in range(day - base_days, day) if z in by and by[z].get(key) is not None]
    if cur is None or len(base) < min_base:
        return None
    med = _median(base)
    dev = [abs(x - med) for x in base]
    rsd = 1.4826 * _median(dev)
    if rsd <= 0:
        rsd = 1.253314 * sum(dev) / len(dev)
    if rsd <= 0:
        # every baseline value is the same: there is no spread to compare with (not "z = 0")
        return {"value": cur, "median": med, "rsd": 0.0, "z": None, "flag": False, "no_variation": True}
    z = (cur - med) / rsd
    return {"value": cur, "median": med, "rsd": rsd, "z": z, "flag": abs(z) > 2.0, "no_variation": False}


def overnight_rhr(hr, a, b):
    """Lowest 5-minute mean of minute HR between UTC seconds a and b (needs 5 consecutive minutes)."""
    sel = [(m, v) for m, v, _ in hr if a <= m * 60 < b]
    best = None
    for k in range(len(sel) - 4):
        if sel[k + 4][0] - sel[k][0] != 4:
            continue
        v = sum(x[1] for x in sel[k:k + 5]) / 5.0
        if best is None or v < best:
            best = v
    return best


def _inside(m, intervals):
    t = m * 60
    for a, b in intervals:
        if a <= t < b:
            return True
    return False


def stress(hr, day, rest_base, max_hr, busy=(), sdnn=(), sdnn_base=None):
    """Descriptive daytime stress per local hour, 0 to 3, from minute HR outside activities and
    sleep (`busy` = UTC second intervals). e = (hour mean HR - resting baseline) / (max - baseline):
    0 below 0.10, 1 below 0.20, 2 below 0.30, else 3. A daytime SDNN reading in that hour whose
    ln is more than 1 SD below the SDNN baseline (mean, sd of ln) adds 1, capped at 3.
    Needs 10 minutes of data in the hour. Not a diagnosis: heat, caffeine, posture and illness
    all raise heart rate."""
    hours = {}
    for m, v, off in hr:
        if local_day_of(m, off) != day or _inside(m, busy):
            continue
        h = int(((m * 60 + off) % 86400) // 3600)
        e = hours.setdefault(h, [0.0, 0])
        e[0] += v
        e[1] += 1
    low_hrv = set()
    if sdnn_base:
        mu, sg = sdnn_base
        for z, h, v in sdnn:
            if z == day and v > 0 and math.log(v) < mu - sg:
                low_hrv.add(int(h))
    out = []
    span = max_hr - rest_base
    for h in sorted(hours):
        tot, n = hours[h]
        if n < 10 or span <= 0:
            continue
        e = (tot / n - rest_base) / span
        lvl = 0 if e < 0.10 else (1 if e < 0.20 else (2 if e < 0.30 else 3))
        if h in low_hrv:
            lvl = min(3, lvl + 1)
        out.append({"hour": h, "mean_hr": tot / n, "minutes": n, "level": lvl, "low_hrv": h in low_hrv})
    return out


def detect_workouts(hr, rest, max_hr, busy=(), frac=0.30, min_minutes=10, max_gap=3):
    """Blocks of minute HR at or above rest + frac x (max - rest), joined across gaps of up to
    `max_gap` minutes, lasting at least `min_minutes`, and not already covered by a recorded
    activity (more than half the block inside `busy`). The user confirms before anything is saved."""
    thr = rest + frac * (max_hr - rest)
    hot = [(m, v) for m, v, _ in hr if v >= thr]
    blocks = []
    for m, v in hot:
        if blocks and m - blocks[-1]["end"] <= max_gap:
            b = blocks[-1]
            b["end"] = m
            b["sum"] += v
            b["n"] += 1
        else:
            blocks.append({"start": m, "end": m, "sum": v, "n": 1})
    out = []
    for b in blocks:
        if b["end"] - b["start"] + 1 < min_minutes:
            continue
        mins = range(b["start"], b["end"] + 1)
        covered = sum(1 for m in mins if _inside(m, busy))
        if covered * 2 > len(mins):
            continue
        out.append({"start": b["start"] * 60, "end": (b["end"] + 1) * 60, "minutes": b["end"] - b["start"] + 1,
                    "avg_hr": b["sum"] / b["n"], "threshold": thr})
    return out


def day_trimp(hr, day, s):
    """Banister TRIMP over every minute of minute HR on a local day (each minute weighted 1 min)."""
    a, bb = (0.86, 1.67) if s["trimp_sex"] == "female" else (0.64, 1.92)
    tot = 0.0
    for m, v, off in hr:
        if local_day_of(m, off) != day:
            continue
        x = (v - s["rest_hr"]) / (s["max_hr"] - s["rest_hr"])
        x = 0.0 if x < 0 else (1.0 if x > 1 else x)
        tot += x * a * math.exp(bb * x)
    return {"trimp": tot, "index": day_index(tot)}


def fmt_clock(minutes):
    m = int(math.floor(minutes + 0.5)) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def sleep_plan(need_h, wake_min, latency_min=15.0):
    """Bedtime = wake time - sleep need - time to fall asleep. Wake window = the 30 min before wake."""
    bed = (wake_min - need_h * 60.0 - latency_min) % 1440
    return {"bedtime": fmt_clock(bed), "bed_min": bed, "wake": fmt_clock(wake_min),
            "window_start": fmt_clock(wake_min - 30), "need_h": need_h, "latency_min": latency_min}


def steps_summary(rows, day, days=7):
    sel = [r["steps"] for r in rows if day - days < r["date"] <= day and r.get("steps") is not None]
    return {"days": len(sel), "mean": mean(sel), "total": sum(sel) if sel else 0.0}
