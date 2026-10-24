"""Logs and summaries built from per-activity summary rows.

A summary row is {"id", "day", "sport", "name", "distance" (m), "moving" (s), "elapsed" (s),
"gain" (m), "load", "kcal", "gear", "fastest": [[distance m, time s or None], ...]}.
"""

from __future__ import annotations

import math

from .example import mulberry32
from .util import civil_from_days, days_from_civil, mean, sd

METRICS = ("distance", "time", "elevation", "sessions")


def week_start(z):
    return z - (z + 3) % 7  # Monday


def period_range(period, z):
    if period == "week":
        a = week_start(z)
        return a, a + 6
    y, m, _ = civil_from_days(z)
    if period == "month":
        a = days_from_civil(y, m, 1)
        b = days_from_civil(y + (1 if m == 12 else 0), 1 if m == 12 else m + 1, 1) - 1
        return a, b
    return days_from_civil(y, 1, 1), days_from_civil(y + 1, 1, 1) - 1


def _value(r, metric):
    if metric == "distance":
        return r.get("distance") or 0.0
    if metric == "time":
        return r.get("moving") or 0.0
    if metric == "elevation":
        return r.get("gain") or 0.0
    return 1.0


def totals(rows, a, b, sport="all"):
    out = {"count": 0, "distance": 0.0, "moving": 0.0, "elevation": 0.0, "load": 0.0, "kcal": 0.0, "by_sport": {}}
    for r in rows:
        if not (a <= r["day"] <= b) or (sport != "all" and r["sport"] != sport):
            continue
        out["count"] += 1
        out["distance"] += r.get("distance") or 0.0
        out["moving"] += r.get("moving") or 0.0
        out["elevation"] += r.get("gain") or 0.0
        out["load"] += r.get("load") or 0.0
        out["kcal"] += r.get("kcal") or 0.0
        bs = out["by_sport"].setdefault(r["sport"], {"count": 0, "distance": 0.0, "moving": 0.0})
        bs["count"] += 1
        bs["distance"] += r.get("distance") or 0.0
        bs["moving"] += r.get("moving") or 0.0
    return out


def goal_progress(rows, goal, day):
    """goal: {"metric", "period" (week, month, year), "target", "sport"}. Progress for the period
    containing `day`, with the share of the period elapsed for an on-pace check."""
    a, b = period_range(goal["period"], day)
    sport = goal.get("sport") or "all"
    v = 0.0
    for r in rows:
        if a <= r["day"] <= b and (sport == "all" or r["sport"] == sport):
            v += _value(r, goal["metric"])
    target = goal["target"]
    elapsed = (day - a + 1) / (b - a + 1)
    frac = v / target if target else None
    return {"start": a, "end": b, "value": v, "target": target, "fraction": frac,
            "elapsed": elapsed, "on_pace": frac is not None and frac >= elapsed, "days_left": b - day}


def periods(rows, period, end_day, count):
    """Totals for the last `count` weeks or months ending with the one containing end_day."""
    out = []
    z = end_day
    for _ in range(count):
        a, b = period_range(period, z)
        t = totals(rows, a, b)
        t["start"], t["end"] = a, b
        out.append(t)
        z = a - 1
    return out[::-1]


def weekly_band(rows, day):
    """This week's load against the mean +/- 1 SD of the previous four full weeks. Descriptive."""
    a = week_start(day)
    cur = totals(rows, a, a + 6)["load"]
    prev = [totals(rows, a - 7 * k, a - 7 * k + 6)["load"] for k in range(1, 5)]
    mu = mean(prev)
    sig = sd(prev) or 0.0
    return {"week": cur, "mean": mu, "sd": sig, "lo": max(0.0, mu - sig), "hi": mu + sig, "previous": prev}


def longest_streak(days):
    best = run = 0
    prev = None
    for z in sorted(set(days)):
        run = run + 1 if prev is not None and z == prev + 1 else 1
        best = max(best, run)
        prev = z
    return best


def year_review(rows, year):
    a, b = days_from_civil(year, 1, 1), days_from_civil(year + 1, 1, 1) - 1
    yr = [r for r in rows if a <= r["day"] <= b]
    t = totals(rows, a, b)
    months = []
    for m in range(1, 13):
        ma = days_from_civil(year, m, 1)
        mb = days_from_civil(year + (1 if m == 12 else 0), 1 if m == 12 else m + 1, 1) - 1
        months.append(totals(rows, ma, mb)["distance"])
    weekdays = [0] * 7
    for r in yr:
        weekdays[(r["day"] + 3) % 7] += 1
    best = {}
    for r in yr:
        for dist, tm in r.get("fastest") or []:
            key = str(int(dist)) if dist == int(dist) else repr(float(dist))  # same text as JS String()
            if tm is not None and (key not in best or tm < best[key][0]):
                best[key] = [tm, r["id"]]
    longest = max(yr, key=lambda r: (r.get("distance") or 0.0, -r["day"]), default=None)
    climb = max(yr, key=lambda r: (r.get("gain") or 0.0, -r["day"]), default=None)
    return {"year": year, "totals": t, "months": months, "active_days": len(set(r["day"] for r in yr)),
            "streak": longest_streak([r["day"] for r in yr]), "weekdays": weekdays,
            "longest": longest["id"] if longest else None, "biggest_climb": climb["id"] if climb else None,
            "best": best, "top_month": (max(range(12), key=lambda k: (months[k], -k)) + 1) if yr else None}


# ---------------------------------------------------------------- gear

def gear_totals(gear, rows):
    """gear: [{"id", "name", "kind", "start_km", "retire_km"}]. Distance and time from rows tagged
    with the gear id; alert when the total reaches the retire distance."""
    out = []
    for g in gear:
        dist = (g.get("start_km") or 0.0) * 1000.0
        mov = 0.0
        n = 0
        for r in rows:
            if r.get("gear") == g["id"]:
                dist += r.get("distance") or 0.0
                mov += r.get("moving") or 0.0
                n += 1
        lim = g.get("retire_km")
        out.append({"id": g["id"], "distance": dist, "moving": mov, "count": n,
                    "retire": bool(lim) and dist >= lim * 1000.0,
                    "remaining": (lim * 1000.0 - dist) if lim else None})
    return out


# ---------------------------------------------------------------- body and cycle

def weight_trend(entries, window=7):
    """Trailing mean of entries within `window` days, per entry, and the change over 30 days."""
    es = sorted((e for e in entries if e.get("kg")), key=lambda e: e["date"])
    out = []
    for e in es:
        vals = [x["kg"] for x in es if e["date"] - window < x["date"] <= e["date"]]
        out.append([e["date"], e["kg"], sum(vals) / len(vals)])
    change = None
    if out:
        last = out[-1]
        earlier = [o for o in out if o[0] <= last[0] - 30]
        if earlier:
            change = last[2] - earlier[-1][2]
    return {"series": out, "change30": change}


def bp_summary(entries, day):
    def avg(days):
        sel = [e for e in entries if day - days < e["date"] <= day and e.get("sys") and e.get("dia")]
        if not sel:
            return None
        return [sum(e["sys"] for e in sel) / len(sel), sum(e["dia"] for e in sel) / len(sel), len(sel)]
    return {"d7": avg(7), "d30": avg(30)}


def cycle_phase(starts, day, default_len=28):
    """Estimated cycle day and phase from user-entered period start days. Ovulation is estimated
    14 days before the next expected start (a calendar estimate, not a measurement)."""
    past = sorted(z for z in starts if z <= day)
    if not past:
        return None
    gaps = [b - a for a, b in zip(past, past[1:]) if 21 <= b - a <= 45][-6:]
    length = sum(gaps) / len(gaps) if gaps else float(default_len)
    start = past[-1]
    cd = day - start + 1
    ov = length - 14.0
    if cd <= 5:
        phase = "menstrual"
    elif cd > length + 7:
        phase = "unknown"
    elif cd < ov - 1:
        phase = "follicular"
    elif cd <= ov + 1:
        phase = "ovulatory"
    else:
        phase = "luteal"
    return {"cycle_day": cd, "length": length, "phase": phase, "next_start": start + int(math.floor(length + 0.5))}


# ---------------------------------------------------------------- journal

def association(answers, metric, day, tag, window=90, perms=2000, seed=12345):
    """Next-day metric on days answered yes against days answered no, within `window` days.
    answers: {day: {tag: bool}}; metric: {day: value}. Needs five of each. Permutation test
    (two-sided, deterministic seed) and Cohen's d with pooled SD. An association, not a cause."""
    yes, no = [], []
    for z in range(day - window + 1, day + 1):
        a = answers.get(z)
        if a is None or tag not in a or metric.get(z + 1) is None:
            continue
        (yes if a[tag] else no).append(metric[z + 1])
    out = {"tag": tag, "n_yes": len(yes), "n_no": len(no), "diff": None, "d": None, "p": None}
    if len(yes) < 5 or len(no) < 5:
        return out
    diff = mean(yes) - mean(no)
    s1, s2 = sd(yes), sd(no)
    pooled = math.sqrt(((len(yes) - 1) * s1 * s1 + (len(no) - 1) * s2 * s2) / (len(yes) + len(no) - 2))
    allv = yes + no
    rnd = mulberry32(seed)
    hits = 0
    ny = len(yes)
    for _ in range(perms):
        v = list(allv)
        for i in range(len(v) - 1, 0, -1):
            j = int(math.floor(rnd() * (i + 1)))
            v[i], v[j] = v[j], v[i]
        dd = sum(v[:ny]) / ny - sum(v[ny:]) / (len(v) - ny)
        if abs(dd) >= abs(diff) - 1e-12:
            hits += 1
    out.update({"diff": diff, "d": diff / pooled if pooled > 0 else None, "p": (hits + 1) / (perms + 1)})
    return out


# ---------------------------------------------------------------- insights and suggestions

def _pct(a, b):
    return (a / b - 1.0) * 100.0 if b else None


def insights(rows, ready, series, day, sleep_rows=None):
    """Plain-language notes from the user's own numbers. Each carries the numbers it used."""
    out = []
    h = ready.get("hrv") if ready else None
    if h and h.get("roll") is not None:
        roll, base = math.exp(h["roll"]), math.exp(h["mean"])
        p = _pct(roll, base)
        word = "below" if p < 0 else "above"
        out.append({"key": "hrv", "text": f"HRV 7-day mean is {abs(p):.0f}% {word} your 60-day baseline.",
                    "numbers": {"week_ms": roll, "baseline_ms": base, "pct": p}})
    k = ready.get("rhr") if ready else None
    if k and k.get("recent") is not None:
        dlt = k["recent"] - k["mean"]
        out.append({"key": "rhr", "text": f"Resting HR is {abs(dlt):.1f} bpm {'above' if dlt > 0 else 'below'} your baseline.",
                    "numbers": {"recent": k["recent"], "baseline": k["mean"], "diff": dlt}})
    wb = weekly_band(rows, day)
    if wb["mean"]:
        p = _pct(wb["week"], wb["mean"])
        out.append({"key": "load", "text": f"This week's load is {abs(p):.0f}% {'above' if p > 0 else 'below'} your 4-week average.",
                    "numbers": {"week": wb["week"], "average": wb["mean"], "pct": p}})
    a = week_start(day)
    this_w = totals(rows, a, a + 6)["distance"]
    last_w = totals(rows, a - 7, a - 1)["distance"]
    if last_w > 0:
        p = _pct(this_w, last_w)
        out.append({"key": "distance", "text": f"Distance so far this week is {this_w / 1000:.1f} km against {last_w / 1000:.1f} km last week.",
                    "numbers": {"this_week_m": this_w, "last_week_m": last_w, "pct": p}})
    if sleep_rows:
        nights = [r["sleep"] for r in sleep_rows if day - 7 < r["date"] <= day and r.get("sleep") is not None]
        if len(nights) >= 3:
            m = sum(nights) / len(nights)
            out.append({"key": "sleep", "text": f"Average sleep over the last {len(nights)} nights is {m:.1f} h.",
                        "numbers": {"mean_h": m, "nights": len(nights)}})
    if series and series.get("form"):
        f = series["fitness"][-1]
        fo = series["form"][-1]
        out.append({"key": "form", "text": f"Form is {fo:.0f} (fitness {f:.0f}, fatigue {series['fatigue'][-1]:.0f}).",
                    "numbers": {"form": fo, "fitness": f, "fatigue": series["fatigue"][-1]}})
    return out


SESSIONS = {
    ("run", "Recover"): "Rest, or 20 to 30 min very easy running in zone 1 to 2.",
    ("run", "Maintain"): "40 to 60 min steady running in zone 2.",
    ("run", "Build"): "Warm up 15 min, 5 x 4 min in zone 4 with 3 min easy between, cool down 10 min.",
    ("ride", "Recover"): "Rest, or 30 to 45 min easy spinning in zone 1.",
    ("ride", "Maintain"): "60 to 90 min steady riding in zone 2.",
    ("ride", "Build"): "Warm up 15 min, 3 x 10 min in zone 4 with 5 min easy between, cool down 10 min.",
    ("other", "Recover"): "Rest or gentle mobility for 20 min.",
    ("other", "Maintain"): "45 min of steady, conversational effort.",
    ("other", "Build"): "A harder session: 30 min with several 3 to 5 min efforts in zone 4.",
}


READY_WHY = {"clear": "no readiness input is off its baseline",
             "one_off": "one readiness input is off its baseline",
             "several_off": "two or more readiness inputs are off their baselines"}


def suggest(rows, ready, series, day):
    """Rule-based session suggestion. A heuristic, not coaching."""
    recent = [r["sport"] for r in rows if day - 28 < r["day"] <= day]
    sport = max(sorted(set(recent)), key=recent.count) if recent else "run"
    if sport not in ("run", "ride"):
        sport = "other"
    state = (ready or {}).get("state", "none")
    fit = series["fitness"][-1] if series and series.get("fitness") else 0.0
    form = series["form"][-1] if series and series.get("form") else 0.0
    rel = form / fit if fit > 0 else 0.0
    if state == "several_off" or (fit > 0 and rel < -0.3):
        intent = "Recover"
    elif state == "one_off" or (fit > 0 and rel < -0.1):
        intent = "Maintain"
    else:
        intent = "Build"
    why = []
    if state != "none":
        why.append(READY_WHY[state])
    if fit > 0:
        why.append(f"form is {form:.0f} against fitness {fit:.0f} ({rel * 100:.0f}%)")
    reason = ("Because " + " and ".join(why) + ".") if why else "No readiness or load data yet; a steady session is the safe default."
    return {"intent": intent, "sport": sport, "session": SESSIONS[(sport, intent)], "reason": reason,
            "numbers": {"state": state, "form": form, "fitness": fit, "ratio": rel}}
