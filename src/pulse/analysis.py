"""Per-activity analysis. Every method is written out in README.md under "Method".

Input is an activity dict with parallel per-sample lists t (Unix s), lat, lon, ele (m), hr (bpm),
cad, pwr (W) and dist (device distance, m); missing values are None.
"""

from __future__ import annotations

import math
from bisect import bisect_left

from .physio import calories, lucia_trimp, pace_zone_time, power_load, power_zone_time, summary_trimp
from .util import haversine

DEFAULTS = {
    "max_hr": 190.0, "rest_hr": 50.0,
    "zone_method": "hrr",         # "hrr" (Karvonen, heart rate reserve) or "max" (% of max HR)
    "trimp_sex": "male",          # Banister weighting: male 0.64 e^(1.92x), female 0.86 e^(1.67x)
    "load_method": "banister",    # "banister" (exponential TRIMP) or "edwards" (zone TRIMP)
    "units": "km",
    "run_stop": 0.5, "run_go": 0.8,     # m/s: below stop = stopped, at or above go = moving again
    "ride_stop": 1.0, "ride_go": 1.5,
    "min_stop": 5.0,              # s: shorter slow spans stay moving
    "ele_window": 5,              # samples in the centred moving average
    "ele_hyst": 3.0,              # m: reversals smaller than this are ignored
    "hr_gap": 60.0,               # s: longer sample gaps are not integrated (HR, zones, load)
    "run_vmax": 12.0, "ride_vmax": 30.0,  # m/s: faster segments are GPS spikes for fastest efforts
    "fit_tau": 42.0, "fat_tau": 7.0,
    "sleep_base": 8.0, "sleep_debt_share": 0.1, "sleep_load_per100": 0.0,
    "weight_kg": 70.0, "age": 40.0,     # for calories and fitness age
    "ftp": 0.0,                   # W, 0 = unknown (power levels and power load off)
    "threshold_speed": 0.0,       # m/s, 0 = unknown (pace zones off)
    "vt1_hr": 0.0, "vt2_hr": 0.0, # bpm, for Lucia's three-zone load when both are set
    "wake_min": 390.0, "sleep_latency": 15.0,
}

TARGETS = [("400 m", 400.0), ("1 km", 1000.0), ("1 mile", 1609.344), ("5 km", 5000.0),
           ("10 km", 10000.0), ("Half marathon", 21097.5)]
MEANMAX = [5, 30, 60, 300, 1200, 3600]
TRIMP_COEF = {"male": (0.64, 1.92), "female": (0.86, 1.67)}


def settings_with(s=None):
    out = dict(DEFAULTS)
    if s:
        out.update({k: v for k, v in s.items() if v is not None})
    return out


def cumdist(act):
    """Cumulative distance per sample: haversine on positions when two or more exist,
    otherwise the device distance channel (forward filled), otherwise zeros."""
    lat, lon, dist = act["lat"], act["lon"], act["dist"]
    n = len(act["t"])
    npos = sum(1 for x in lat if x is not None)
    d = [0.0] * n
    if npos >= 2:
        acc = 0.0
        last = None
        for i in range(n):
            if lat[i] is not None and lon[i] is not None:
                if last is not None:
                    acc += haversine(last[0], last[1], lat[i], lon[i])
                last = (lat[i], lon[i])
            d[i] = acc
        return d
    if sum(1 for x in dist if x is not None) >= 2:
        base = None
        prev = 0.0
        for i in range(n):
            if dist[i] is not None:
                if base is None:
                    base = dist[i]
                prev = max(prev, dist[i] - base)
            d[i] = prev
    return d


def moving_mask(t, d, sport, s, pauses=()):
    """Per-segment moving flag (index i covers samples i-1 to i; index 0 unused) with speed
    hysteresis, a minimum stop duration and device timer pauses."""
    n = len(t)
    stop = s["ride_stop"] if sport == "ride" else s["run_stop"]
    go = s["ride_go"] if sport == "ride" else s["run_go"]
    mov = [False] * n
    state = None
    for i in range(1, n):
        dt = t[i] - t[i - 1]
        v = (d[i] - d[i - 1]) / dt if dt > 0 else 0.0
        if state is None:
            state = v >= stop
        elif state and v < stop:
            state = False
        elif not state and v >= go:
            state = True
        mov[i] = state and dt > 0
    # short stops (total under min_stop seconds) count as moving
    i = 1
    while i < n:
        if not mov[i]:
            j = i
            dur = 0.0
            while j < n and not mov[j]:
                dur += max(0.0, t[j] - t[j - 1])
                j += 1
            if dur < s["min_stop"]:
                for k in range(i, j):
                    if t[k] - t[k - 1] > 0:
                        mov[k] = True
            i = j
        else:
            i += 1
    for a, b in pauses:
        for i in range(1, n):
            mid = (t[i] + t[i - 1]) / 2
            if a <= mid <= b:
                mov[i] = False
    return mov


def smooth(vals, window):
    w = int(window)
    if w < 1:
        w = 1
    if w % 2 == 0:
        w += 1
    h = w // 2
    n = len(vals)
    c = [0.0] * (n + 1)
    for i in range(n):
        c[i + 1] = c[i] + vals[i]
    out = []
    for i in range(n):
        lo = max(0, i - h)
        hi = min(n, i + h + 1)
        out.append((c[hi] - c[lo]) / (hi - lo))
    return out


def zigzag(vals, h):
    """Gain and loss counting only legs between turning points that reverse by at least h."""
    gain = loss = 0.0
    if not vals:
        return 0.0, 0.0
    lo = hi = vals[0]
    direction = 0
    anchor = cand = vals[0]
    for x in vals[1:]:
        if direction == 0:
            if x < lo:
                lo = x
            if x > hi:
                hi = x
            if x - lo >= h and x - lo >= hi - x:
                direction, anchor, cand = 1, lo, x
            elif hi - x >= h:
                direction, anchor, cand = -1, hi, x
        elif direction == 1:
            if x > cand:
                cand = x
            elif cand - x >= h:
                gain += cand - anchor
                anchor, cand, direction = cand, x, -1
        else:
            if x < cand:
                cand = x
            elif x - cand >= h:
                loss += anchor - cand
                anchor, cand, direction = cand, x, 1
    if direction == 1:
        gain += cand - anchor
    elif direction == -1:
        loss += anchor - cand
    return gain, loss


def elevation(ele, s):
    """Raw gain (every rise summed) beside corrected gain (moving average, then zigzag filter)."""
    vals = [e for e in ele if e is not None]
    if len(vals) < 2:
        return None
    raw = 0.0
    for i in range(1, len(vals)):
        if vals[i] > vals[i - 1]:
            raw += vals[i] - vals[i - 1]
    sm = smooth(vals, s["ele_window"])
    gain, loss = zigzag(sm, s["ele_hyst"])
    return {"raw_gain": raw, "gain": gain, "loss": loss, "min": min(sm), "max": max(sm)}


def filled_smoothed(ele, s):
    """Smoothed elevation aligned to every sample (gaps carried from the nearest earlier value)."""
    idx = [i for i, e in enumerate(ele) if e is not None]
    if len(idx) < 2:
        return None
    sm = smooth([ele[i] for i in idx], s["ele_window"])
    out = [None] * len(ele)
    for k, i in enumerate(idx):
        out[i] = sm[k]
    first = sm[0]
    prev = first
    for i in range(len(out)):
        if out[i] is None:
            out[i] = prev
        else:
            prev = out[i]
    return out


def interp_at(d, ys, x):
    """Value of ys at cumulative distance x (linear; first sample where d reaches x)."""
    n = len(d)
    j = bisect_left(d, x)
    if j <= 0:
        return ys[0]
    if j >= n:
        return ys[n - 1]
    f = (x - d[j - 1]) / (d[j] - d[j - 1])
    return ys[j - 1] + f * (ys[j] - ys[j - 1])


def splits(t, d, mov, ez, hr, unit_m, s):
    total = d[-1] if d else 0.0
    if total <= 0:
        return []
    bounds = []
    k = 1
    while k * unit_m <= total:
        bounds.append(k * unit_m)
        k += 1
    last = bounds[-1] if bounds else 0.0
    if total - last >= 10.0:
        bounds.append(total)
    out = []
    a = 0.0
    n = len(t)
    for b in bounds:
        ta = interp_at(d, t, a)
        tb = interp_at(d, t, b)
        moving = 0.0
        wsum = hsum = 0.0
        j0 = max(1, bisect_left(d, a))
        for i in range(j0, n):
            if d[i - 1] >= b:
                break
            dd = d[i] - d[i - 1]
            if dd <= 0:
                continue
            ov = min(b, d[i]) - max(a, d[i - 1])
            if ov <= 0:
                continue
            dt = t[i] - t[i - 1]
            frac = ov / dd
            if mov[i]:
                moving += dt * frac
            if hr[i - 1] is not None and 0 < dt <= s["hr_gap"]:
                wsum += dt * frac
                hsum += dt * frac * hr[i - 1]
        out.append({
            "index": len(out) + 1, "distance": b - a, "elapsed": tb - ta, "moving": moving,
            "ele_delta": (interp_at(d, ez, b) - interp_at(d, ez, a)) if ez else None,
            "avg_hr": hsum / wsum if wsum > 0 else None})
        a = b
    return out


def bad_prefix(t, d, vmax):
    """B[i] = number of implausible segments among 1..i (speed over vmax, or distance in zero time)."""
    n = len(t)
    b = [0] * n
    for i in range(1, n):
        dt = t[i] - t[i - 1]
        dd = d[i] - d[i - 1]
        bad = (dd > 0 and dt <= 0) or (dt > 0 and dd / dt > vmax)
        b[i] = b[i - 1] + (1 if bad else 0)
    return b


def fastest(t, d, target, bad):
    """Shortest elapsed time covering `target` metres. Sliding window on cumulative distance;
    windows start or end on a sample with the other end interpolated, which is exact for a
    piecewise-linear track. Windows that contain a flagged segment are skipped."""
    n = len(t)
    best = None
    best_start = None
    j = 0
    for i in range(n):
        while j < n and d[j] - d[i] < target:
            j += 1
        if j >= n:
            break
        if bad[j] - bad[i] > 0:
            continue
        x = d[i] + target
        f = (x - d[j - 1]) / (d[j] - d[j - 1])
        te = t[j - 1] + f * (t[j] - t[j - 1])
        el = te - t[i]
        if best is None or el < best:
            best, best_start = el, t[i]
    i = 0
    for j in range(n):
        while i + 1 <= j and d[j] - d[i + 1] >= target:
            i += 1
        if d[j] - d[i] < target or i + 1 > j:
            continue
        if bad[j] - bad[i] > 0:
            continue
        x = d[j] - target
        f = (x - d[i]) / (d[i + 1] - d[i])
        ts = t[i] + f * (t[i + 1] - t[i])
        el = t[j] - ts
        if best is None or el < best:
            best, best_start = el, ts
    if best is None:
        return None
    return {"time": best, "start": best_start - t[0]}


def zone_bounds(s):
    mx, rest = s["max_hr"], s["rest_hr"]
    fr = [0.5, 0.6, 0.7, 0.8, 0.9]
    if s["zone_method"] == "max":
        return [f * mx for f in fr]
    return [rest + f * (mx - rest) for f in fr]


def heart(t, hr, s):
    """Time-weighted HR stats, time in zone, Banister TRIMP and Edwards TRIMP, sample and hold."""
    bounds = zone_bounds(s)
    a, b = TRIMP_COEF.get(s["trimp_sex"], TRIMP_COEF["male"])
    mx, rest = s["max_hr"], s["rest_hr"]
    zones = [0.0] * 6
    tsum = hsum = trimp = edw = 0.0
    for i in range(1, len(t)):
        dt = t[i] - t[i - 1]
        h = hr[i - 1]
        if h is None or dt <= 0 or dt > s["hr_gap"]:
            continue
        tsum += dt
        hsum += h * dt
        z = 0
        for bd in bounds:
            if h >= bd:
                z += 1
        zones[z] += dt
        x = (h - rest) / (mx - rest)
        x = 0.0 if x < 0 else (1.0 if x > 1 else x)
        trimp += dt / 60.0 * x * a * math.exp(b * x)
        p = h / mx
        w = 0 if p < 0.5 else 1 if p < 0.6 else 2 if p < 0.7 else 3 if p < 0.8 else 4 if p < 0.9 else 5
        edw += dt / 60.0 * w
    if tsum <= 0:
        return None
    hmax = max(h for h in hr if h is not None)
    return {"avg": hsum / tsum, "max": hmax, "time": tsum, "zones": zones, "bounds": bounds,
            "trimp": trimp, "edwards": edw}


def power(t, pwr, s):
    """1 s sample-and-hold grid (gaps over hr_gap read as 0 W), average, 30 s rolling
    fourth-power mean (Coggan's weighted average), and mean-maximal power."""
    if sum(1 for p in pwr if p is not None) < 2:
        return None
    t0 = t[0]
    T = int(math.floor(t[-1] - t0))
    n = len(t)
    grid = []
    k = 0
    for sec in range(T + 1):
        while k + 1 < n and t[k + 1] - t0 <= sec:
            k += 1
        p = pwr[k]
        grid.append(p if p is not None and sec - (t[k] - t0) <= s["hr_gap"] else 0.0)
    c = [0.0]
    for p in grid:
        c.append(c[-1] + p)
    m = len(grid)
    avg = c[m] / m
    weighted = None
    if m >= 30:
        acc = 0.0
        cnt = 0
        for kk in range(29, m):
            r = (c[kk + 1] - c[kk - 29]) / 30.0
            acc += r * r * r * r
            cnt += 1
        weighted = (acc / cnt) ** 0.25
    mm = {}
    for w in MEANMAX:
        if w <= m:
            best = 0.0
            for kk in range(0, m - w + 1):
                v = (c[kk + w] - c[kk]) / w
                if v > best:
                    best = v
            mm[str(w)] = best
    return {"avg": avg, "weighted": weighted, "max": max(p for p in pwr if p is not None), "meanmax": mm}


def minetti_cost(i):
    """Energy cost of running, J/kg/m, at gradient i (rise over run). Minetti et al. 2002."""
    if i < -0.45:
        i = -0.45
    if i > 0.45:
        i = 0.45
    return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6


def grade_adjusted(t, d, mov, ez, chunk=20.0):
    """Equivalent flat distance over moving segments using Minetti's cost ratio Cr(i)/Cr(0),
    with the grade measured over chunks of at least `chunk` metres."""
    if not ez:
        return None
    n = len(t)
    eq = mt = 0.0
    s = 0
    c0 = minetti_cost(0.0)
    for i in range(1, n):
        if d[i] - d[s] >= chunk or i == n - 1:
            span = d[i] - d[s]
            grade = (ez[i] - ez[s]) / span if span >= chunk else 0.0
            ratio = minetti_cost(grade) / c0
            for k in range(s + 1, i + 1):
                if mov[k]:
                    mt += t[k] - t[k - 1]
                    eq += (d[k] - d[k - 1]) * ratio
            s = i
    if mt <= 0 or eq <= 0:
        return None
    return {"flat_distance": eq, "speed": eq / mt}


def lap_table(t, d, hr, laps, s):
    """Device laps re-measured on this track: distance, elapsed time and average HR between lap starts."""
    starts = sorted(x["start"] for x in laps if x.get("start") is not None)
    if not starts or not t:
        return []
    starts = [max(t[0], a) for a in starts]
    out = []
    for k, a in enumerate(starts):
        b = starts[k + 1] if k + 1 < len(starts) else t[-1]
        if b <= a:
            continue
        da = interp_time(t, d, a)
        db = interp_time(t, d, b)
        wsum = hsum = 0.0
        for i in range(1, len(t)):
            if t[i - 1] >= a and t[i] <= b and hr[i - 1] is not None and 0 < t[i] - t[i - 1] <= s["hr_gap"]:
                wsum += t[i] - t[i - 1]
                hsum += (t[i] - t[i - 1]) * hr[i - 1]
        out.append({"index": len(out) + 1, "distance": db - da, "elapsed": b - a, "avg_hr": hsum / wsum if wsum > 0 else None})
    return out


def interp_time(t, d, x):
    """Cumulative distance at time x."""
    n = len(t)
    j = bisect_left(t, x)
    if j <= 0:
        return d[0]
    if j >= n:
        return d[n - 1]
    if t[j] == t[j - 1]:
        return d[j]
    f = (x - t[j - 1]) / (t[j] - t[j - 1])
    return d[j - 1] + f * (d[j] - d[j - 1])


def max_speed(t, d, bad):
    best = 0.0
    for i in range(1, len(t)):
        dt = t[i] - t[i - 1]
        if dt > 0 and bad[i] == bad[i - 1]:
            v = (d[i] - d[i - 1]) / dt
            if v > best:
                best = v
    return best


def analyze_summary(summ, settings=None, rpe=None):
    """Summary-only activities (Whoop workouts, Strava manual entries): no streams, so load uses
    the average-HR approximation and calories fall back to the summary value or METs."""
    s = settings_with(settings)
    dur = summ.get("duration") or 0.0
    dist = summ.get("distance") or 0.0
    load = summary_trimp(summ.get("avg_hr"), dur / 60.0, s)
    src = "approx" if load is not None else None
    if load is None and rpe is not None:
        load, src = float(rpe) * dur / 60.0, "rpe"
    kc = summ.get("kcal")
    if kc is None:
        kc = calories([], [], summ.get("sport", "other"), dur, dist / dur if dur else 0.0, s)["kcal"]
    return {"sport": summ.get("sport", "other"), "distance": dist, "elapsed": dur, "moving": dur,
            "gain": summ.get("gain") or 0.0, "avg_hr": summ.get("avg_hr"), "max_hr": summ.get("max_hr"),
            "load": load, "load_source": src, "kcal": kc}


def analyze(act, settings=None, rpe=None):
    s = settings_with(settings)
    t = act["t"]
    n = len(t)
    d = cumdist(act)
    sport = act.get("sport", "other")
    mov = moving_mask(t, d, sport, s, act.get("pauses") or ())
    moving = sum(t[i] - t[i - 1] for i in range(1, n) if mov[i])
    elapsed = t[-1] - t[0] if n else 0.0
    dist = d[-1] if n else 0.0
    ele = elevation(act["ele"], s)
    ez = filled_smoothed(act["ele"], s)
    unit_m = 1609.344 if s["units"] == "mi" else 1000.0
    vmax = s["ride_vmax"] if sport == "ride" else s["run_vmax"]
    bad = bad_prefix(t, d, vmax)
    best = []
    for label, D in TARGETS:
        r = fastest(t, d, D, bad) if dist >= D else None
        best.append({"label": label, "distance": D, "time": r["time"] if r else None,
                     "start": r["start"] if r else None})
    hrs = heart(t, act["hr"], s)
    load = None
    load_source = None
    lu = lucia_trimp(t, act["hr"], s["vt1_hr"], s["vt2_hr"], s)
    if hrs:
        if s["load_method"] == "lucia" and lu is not None:
            load, load_source = lu, "lucia"
        else:
            load = hrs["edwards"] if s["load_method"] == "edwards" else hrs["trimp"]
            load_source = "edwards" if s["load_method"] == "edwards" else "banister"
    elif rpe is not None:
        load = float(rpe) * moving / 60.0
        load_source = "rpe"
    session = act.get("session") or {}
    pw = power(t, act["pwr"], s)
    speed = dist / moving if moving > 0 else None
    return {
        "calories": calories(t, act["hr"], sport, moving, speed or 0.0, s),
        "power_zones": power_zone_time(t, act["pwr"], s["ftp"], s) if pw else None,
        "power_load": power_load(pw["weighted"], elapsed, s["ftp"]) if pw else None,
        "pace_zones": pace_zone_time(t, d, mov, s["threshold_speed"]) if sport == "run" else None,
        "lucia": lucia_trimp(t, act["hr"], s["vt1_hr"], s["vt2_hr"], s),
        "max_speed": max_speed(t, d, bad),
        "lap_table": lap_table(t, d, act["hr"], act.get("laps") or [], s),
        "sport": sport, "start": act["start"], "points": n,
        "distance": dist, "elapsed": elapsed, "moving": moving,
        "timer": session.get("timer"),
        "speed": speed,
        "elevation": ele,
        "splits": splits(t, d, mov, ez, act["hr"], unit_m, s),
        "fastest": best,
        "hr": hrs,
        "load": load, "load_source": load_source,
        "power": pw,
        "gap": grade_adjusted(t, d, mov, ez) if sport == "run" else None,
        "laps": len(act.get("laps") or []),
    }
