"""Energy, fitness estimates, race predictions, zones and alternative load models.
Every equation and its source is listed in README.md under "Method". All outputs are estimates."""

from __future__ import annotations

import math

# ---------------------------------------------------------------- calories

def keytel_kcal_per_min(hr, weight_kg, age, sex):
    """Keytel et al. 2005 (J Sports Sci 23(3):289-297), equation without VO2max, kJ/min / 4.184."""
    if sex == "female":
        kj = -20.4022 + 0.4472 * hr - 0.1263 * weight_kg + 0.074 * age
    else:
        kj = -55.0969 + 0.6309 * hr + 0.1988 * weight_kg + 0.2017 * age
    return max(0.0, kj / 4.184)


# Compendium of Physical Activities (Ainsworth et al. 2011): running MET by speed (mph)
RUN_MET = [(4.0, 6.0), (5.0, 8.3), (5.2, 9.0), (6.0, 9.8), (6.7, 10.5), (7.0, 11.0), (7.5, 11.5), (8.0, 11.8),
           (8.6, 12.3), (9.0, 12.8), (10.0, 14.5), (11.0, 16.0), (12.0, 19.0), (13.0, 19.8), (14.0, 23.0)]
# bicycling, general by speed band (mph lower bound -> MET)
RIDE_MET = [(0.0, 4.0), (10.0, 6.8), (12.0, 8.0), (14.0, 10.0), (16.0, 12.0), (20.0, 15.8)]
OTHER_MET = 5.0
WALK_MET = 3.5  # below 4 mph on foot: walking, about 3 mph


def met_for(sport, speed_ms):
    mph = (speed_ms or 0.0) * 2.2369362920544
    if sport == "run":
        if mph < RUN_MET[0][0]:
            return WALK_MET
        for k in range(1, len(RUN_MET)):
            if mph <= RUN_MET[k][0]:
                (x0, y0), (x1, y1) = RUN_MET[k - 1], RUN_MET[k]
                return y0 + (mph - x0) / (x1 - x0) * (y1 - y0)
        return RUN_MET[-1][1]
    if sport == "ride":
        m = RIDE_MET[0][1]
        for lo, v in RIDE_MET:
            if mph >= lo:
                m = v
        return m
    if sport == "strength":
        return 3.5
    return OTHER_MET


def calories(t, hr, sport, moving_s, speed_ms, s):
    """Keytel per sample (sample and hold, gaps over hr_gap skipped) when HR covers at least half
    the moving time; otherwise MET x kg x hours."""
    kcal = 0.0
    covered = 0.0
    for i in range(1, len(t)):
        dt = t[i] - t[i - 1]
        h = hr[i - 1] if i - 1 < len(hr) else None
        if h is None or dt <= 0 or dt > s["hr_gap"]:
            continue
        kcal += keytel_kcal_per_min(h, s["weight_kg"], s["age"], s["trimp_sex"]) * dt / 60.0
        covered += dt
    if moving_s > 0 and covered >= 0.5 * moving_s:
        return {"kcal": kcal, "method": "keytel"}
    met = met_for(sport, speed_ms)
    return {"kcal": met * s["weight_kg"] * moving_s / 3600.0, "method": "met", "met": met}


# ---------------------------------------------------------------- VO2max, VDOT, predictions

def vo2max_uth(max_hr, rest_hr):
    """Uth, Sorensen, Overgaard, Pedersen 2004 (Eur J Appl Physiol 91:111-115): 15.3 x HRmax/HRrest."""
    if not rest_hr or rest_hr <= 0 or not max_hr:
        return None
    return 15.3 * max_hr / rest_hr


def vdot(distance_m, time_s):
    """Daniels and Gilbert 1979 (Oxygen Power): oxygen cost of velocity over fraction sustainable."""
    if not distance_m or not time_s or time_s <= 0:
        return None
    tmin = time_s / 60.0
    v = distance_m / tmin
    vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v
    pct = 0.8 + 0.1894393 * math.exp(-0.012778 * tmin) + 0.2989558 * math.exp(-0.1932605 * tmin)
    return vo2 / pct


def riegel(time_s, d1, d2, exponent=1.06):
    """Riegel 1981 (American Scientist 69:285-290): T2 = T1 x (D2/D1)^1.06."""
    return time_s * (d2 / d1) ** exponent


RACES = [("5 km", 5000.0), ("10 km", 10000.0), ("Half marathon", 21097.5), ("Marathon", 42195.0)]


def best_vdot(efforts):
    """efforts: list of (distance m, time s). Uses efforts of 1 mile or longer (Daniels' tables start
    near 1500 m). Returns the effort with the highest VDOT and race predictions from it."""
    best = None
    for d, tm in efforts:
        if d is None or tm is None or d < 1609.0:
            continue
        v = vdot(d, tm)
        if v is not None and (best is None or v > best["vdot"]):
            best = {"vdot": v, "distance": d, "time": tm}
    if best is None:
        return None
    best["predictions"] = [{"label": lab, "distance": D, "time": riegel(best["time"], best["distance"], D)}
                           for lab, D in RACES]
    return best


# FRIEND registry treadmill VO2max 50th percentiles (Kaminsky et al. 2022, Mayo Clin Proc 97(2):285-293),
# age-group midpoints 25 .. 85.
NORM_AGES = [25.0, 35.0, 45.0, 55.0, 65.0, 75.0, 85.0]
NORM_MEN = [46.5, 39.7, 35.3, 29.2, 24.6, 20.6, 17.6]
NORM_WOMEN = [36.6, 28.3, 25.7, 22.9, 19.6, 17.2, 15.4]


def fitness_age(vo2, sex):
    """Age at which the sex-specific 50th percentile equals vo2 (linear between group midpoints,
    clamped to 20 and 90). An estimate for orientation only."""
    if vo2 is None:
        return None
    norm = NORM_WOMEN if sex == "female" else NORM_MEN
    if vo2 >= norm[0]:
        a = NORM_AGES[0] - (vo2 - norm[0]) / (norm[0] - norm[1]) * 10.0
        return max(20.0, a)
    for k in range(1, len(norm)):
        if vo2 >= norm[k]:
            f = (norm[k - 1] - vo2) / (norm[k - 1] - norm[k])
            return NORM_AGES[k - 1] + f * 10.0
    a = NORM_AGES[-1] + (norm[-1] - vo2) / (norm[-2] - norm[-1]) * 10.0
    return min(90.0, a)


# ---------------------------------------------------------------- zones and alternative loads

POWER_ZONES = [0.55, 0.75, 0.90, 1.05, 1.20, 1.50]   # Allen and Coggan 7-level table, fraction of FTP
PACE_ZONES = [0.78, 0.88, 0.95, 1.00, 1.04]          # Pulse's own 6-zone table, fraction of threshold speed


def power_zone_time(t, pwr, ftp, s):
    """Seconds in each of the 7 power levels on the 1 s sample-and-hold grid."""
    if not ftp or sum(1 for p in pwr if p is not None) < 2:
        return None
    out = [0.0] * 7
    t0 = t[0]
    T = int(math.floor(t[-1] - t0))
    n = len(t)
    k = 0
    for sec in range(T + 1):
        while k + 1 < n and t[k + 1] - t0 <= sec:
            k += 1
        p = pwr[k]
        v = p if p is not None and sec - (t[k] - t0) <= s["hr_gap"] else 0.0
        z = 0
        for b in POWER_ZONES:
            if v >= b * ftp:
                z += 1
        out[z] += 1.0
    return out


def pace_zone_time(t, d, mov, threshold_speed):
    """Moving seconds in each of 6 pace zones (segment speed against threshold speed)."""
    if not threshold_speed:
        return None
    out = [0.0] * 6
    for i in range(1, len(t)):
        if not mov[i]:
            continue
        dt = t[i] - t[i - 1]
        v = (d[i] - d[i - 1]) / dt
        z = 0
        for b in PACE_ZONES:
            if v >= b * threshold_speed:
                z += 1
        out[z] += dt
    return out


def lucia_trimp(t, hr, vt1, vt2, s):
    """Lucia et al. 2003: minutes below VT1 x 1, between VT1 and VT2 x 2, above VT2 x 3."""
    if not vt1 or not vt2:
        return None
    tot = 0.0
    seen = False
    for i in range(1, len(t)):
        dt = t[i] - t[i - 1]
        h = hr[i - 1]
        if h is None or dt <= 0 or dt > s["hr_gap"]:
            continue
        seen = True
        w = 1 if h < vt1 else (2 if h < vt2 else 3)
        tot += dt / 60.0 * w
    return tot if seen else None


def power_load(weighted, seconds, ftp):
    """Threshold-relative power load: hours x (weighted/FTP)^2 x 100 (Allen and Coggan's published form)."""
    if not weighted or not ftp or seconds <= 0:
        return None
    rel = weighted / ftp
    return seconds / 3600.0 * rel * rel * 100.0


def power_hr_ratio(pairs, minimum=10):
    """Least squares slope through the origin of power load on TRIMP over rides with both.
    Used to estimate a power load for heart-rate-only rides once `minimum` rides exist."""
    pairs = [(p, h) for p, h in pairs if p is not None and h is not None and h > 0]
    if len(pairs) < minimum:
        return None
    num = sum(p * h for p, h in pairs)
    den = sum(h * h for _, h in pairs)
    return num / den if den > 0 else None


def day_index(trimp_total):
    """Pulse day load index, 0 to 10: 10 x ln(1 + T/25) / ln(1 + 1000/25), capped at 10.
    A log scale so the first hour of work moves it more than the fifth."""
    if trimp_total is None or trimp_total <= 0:
        return 0.0
    return min(10.0, 10.0 * math.log(1.0 + trimp_total / 25.0) / math.log(1.0 + 1000.0 / 25.0))


def summary_trimp(avg_hr, minutes, s):
    """Approximate Banister TRIMP from an average HR (for summary-only imports). Understates
    interval sessions; labelled approximate wherever it is shown."""
    if avg_hr is None or not minutes:
        return None
    a, b = (0.86, 1.67) if s["trimp_sex"] == "female" else (0.64, 1.92)
    x = (avg_hr - s["rest_hr"]) / (s["max_hr"] - s["rest_hr"])
    x = 0.0 if x < 0 else (1.0 if x > 1 else x)
    return minutes * x * a * math.exp(b * x)
