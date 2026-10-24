"""Synthetic example athlete: about 90 days of runs and rides with GPS, elevation, HR, power and
cadence, plus daily rMSSD, resting HR and sleep. Entirely generated; no real person and no real
place. The course sits on open ocean at 41.0 N, 40.0 W so it cannot be anyone's home or route.

Deterministic: the same seed and end day give the same data in Python and in the browser
(mulberry32 generator, identical arithmetic in both).
"""

from __future__ import annotations

import math

LAT0 = 41.0
LON0 = -40.0
M32 = 0xFFFFFFFF
EXAMPLE_SETTINGS = {"max_hr": 190.0, "rest_hr": 50.0}


def _imul(a, b):
    return (a * b) & M32


def mulberry32(seed):
    state = [seed & M32]

    def rnd():
        a = (state[0] + 0x6D2B79F5) & M32
        state[0] = a
        t = _imul(a ^ (a >> 15), 1 | a)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & M32) ^ t
        return ((t ^ (t >> 14)) & M32) / 4294967296.0
    return rnd


def _gauss(rnd):
    u = rnd()
    v = rnd()
    if u < 1e-12:
        u = 1e-12
    return math.sqrt(-2.0 * math.log(u)) * math.cos(2.0 * math.pi * v)


def _round(x):
    return math.floor(x + 0.5)


def route_xy(route, u):
    """Route centre lines in metres from the course origin; u is a path parameter close to metres."""
    if route == 0:  # reservoir loop, about 6.6 km around
        th = u / 1050.0
        r = 1.0 + 0.05 * math.sin(5.0 * th)
        return (1300.0 * r * math.cos(th) - 1300.0, 800.0 * r * math.sin(th))
    if route == 1:  # ridge road, out and back
        return (u * 0.83 + 150.0 * math.sin(u / 400.0), u * 0.56 + 80.0 * math.cos(u / 530.0) - 80.0)
    th = u / 6500.0  # route 2: island ride loop, about 45 km
    return (7000.0 * math.cos(th) + 1500.0 * math.cos(3.0 * th) - 8500.0,
            5000.0 * math.sin(th) + 900.0 * math.sin(2.0 * th))


def terrain(x, y):
    return 120.0 + 35.0 * math.sin(x / 900.0) + 22.0 * math.cos(y / 650.0) + 10.0 * math.sin((x + y) / 300.0)


def _to_latlon(x, y):
    k = math.pi / 180.0 * 6371008.8
    return (LAT0 + y / k, LON0 + x / (k * math.cos(LAT0 * math.pi / 180.0)))


def _plan(kind, week_vol, rnd):
    """Phases: (amount, target, unit). Runs: amount metres, target m/s. Rides: seconds, watts."""
    if kind == "intervals":
        reps = 6
        ph = [(2000.0, 3.0, "m")]
        for _ in range(reps):
            ph += [(800.0, 4.35, "m"), (400.0, 2.6, "m")]
        return ph + [(2000.0, 2.9, "m")], 0, "Intervals 6 x 800 m"
    if kind == "tempo":
        return [(2000.0, 3.0, "m"), (6000.0 * week_vol, 3.75, "m"), (2000.0, 2.9, "m")], 1, "Tempo, ridge road"
    if kind == "easy":
        return [(6000.0 + 2000.0 * rnd(), 3.0, "m")], 0, "Easy run, reservoir loop"
    if kind == "long":
        L = 14000.0 * week_vol + 2000.0 * rnd()
        return [(L - 3000.0, 2.95, "m"), (3000.0, 3.3, "m")], 1, "Long run, ridge road"
    if kind == "ride":
        return [(3600.0 + 1200.0 * rnd(), 150.0, "s")], 2, "Easy ride, island loop"
    return [(7200.0 * week_vol + 1800.0 * rnd(), 165.0, "s")], 2, "Long ride, island loop"


def _activity(kind, start_t, week_vol, rnd, s):
    phases, route, name = _plan(kind, week_vol, rnd)
    ride = route == 2
    dt = 3.0 if ride else 2.0
    mx, rest = s["max_hr"] - 2.0, s["rest_hr"] - 2.0
    total = 0.0
    for amt, _, unit in phases:
        total += amt
    t = []; lat = []; lon = []; ele = []; hr = []; cad = []; pwr = []
    u = 0.0
    direction = 1.0
    travelled = 0.0
    el = 0.0
    h = rest + 30.0
    v = 0.0
    phase = 0
    used = 0.0
    stop_at = -1.0
    if kind == "easy" and rnd() < 0.7:
        stop_at = 1500.0 + 3000.0 * rnd()
    stopped = 0.0
    drift = _gauss(rnd) * 2.0
    gx = gy = 0.0
    while phase < len(phases):
        amt, target, unit = phases[phase]
        x, y = route_xy(route, u)
        x2, y2 = route_xy(route, u + direction * 5.0)
        ez = terrain(x, y)
        grade = (terrain(x2, y2) - ez) / 5.0
        if ride:
            p = target * (1.0 + 8.0 * grade) * (1.0 + 0.05 * _gauss(rnd))
            if grade < -0.03 or p < 0:
                p = 0.0
            vt = 7.5 * (max(p, 60.0) / 160.0) ** (1.0 / 3.0) * (1.0 - 6.0 * grade)
            vt = min(16.0, max(2.5, vt))
            rel = p / 240.0
        else:
            p = None
            vt = target * (1.0 - 2.5 * grade)
            rel = target / 4.0
        if stop_at >= 0 and travelled >= stop_at and stopped < 40.0:
            vt = 0.0
            stopped += dt
        v = v + (vt - v) * 0.5
        if v < 0.05:
            v = 0.0
        hr_t = rest + (mx - rest) * (0.25 + 0.62 * rel ** 1.5) + 120.0 * grade + 4.0 * el / 3600.0
        if vt == 0.0:
            hr_t = rest + (mx - rest) * 0.35
        h = h + (hr_t - h) * (1.0 - math.exp(-dt / 25.0))
        gx = 0.95 * gx + 0.3 * _gauss(rnd)
        gy = 0.95 * gy + 0.3 * _gauss(rnd)
        la, lo = _to_latlon(x + gx, y + gy)
        t.append(start_t + el)
        lat.append(la)
        lon.append(lo)
        ele.append(ez + drift + 0.3 * _gauss(rnd))
        hr.append(float(_round(h + 0.8 * _gauss(rnd))))
        if ride:
            pwr.append(float(_round(p)))
            cad.append(float(_round(86.0 + 3.0 * _gauss(rnd))) if p > 0 else 0.0)
        else:
            pwr.append(None)
            cad.append(float(_round(166.0 + 10.0 * rel + 2.0 * _gauss(rnd))) if v > 0 else 0.0)
        ds = v * dt
        xa, ya = route_xy(route, u + 0.5)
        xb, yb = route_xy(route, u - 0.5)
        stretch = math.sqrt((xa - xb) * (xa - xb) + (ya - yb) * (ya - yb))
        u += direction * ds / max(stretch, 1e-6)
        travelled += ds
        el += dt
        used += dt if unit == "s" else ds
        if route == 1 and direction > 0 and travelled >= total / 2.0:
            direction = -1.0
        if used >= amt:
            phase += 1
            used = 0.0
    return {"source": "example", "name": name, "sport": "ride" if ride else "run", "start": t[0],
            "t": t, "lat": lat, "lon": lon, "ele": ele, "hr": hr, "cad": cad, "pwr": pwr,
            "dist": [None] * len(t), "laps": [], "session": None, "pauses": [], "rr": [], "warnings": []}


WEEK = {1: "intervals", 2: "ride", 3: "tempo", 4: "easy", 5: "long", 6: "longride"}  # Monday = 0 rest


def generate(end_day: int, days: int = 90, seed: int = 20261021, settings=None):
    """Return (activities, daily recovery rows) for the `days` days ending on `end_day`."""
    s = dict(EXAMPLE_SETTINGS)
    if settings:
        s.update(settings)
    rnd = mulberry32(seed)
    start_day = end_day - days + 1
    acts = []
    effort = {}
    for z in range(start_day, end_day + 1):
        wd = (z + 3) % 7
        k = (z - start_day) // 7
        vol = (1.0 + 0.04 * k) * (0.75 if k % 4 == 3 else 1.0)
        kind = WEEK.get(wd)
        if kind == "easy" and rnd() < 0.35:
            kind = None
        if z > end_day - 10 and wd == 0:
            kind = "easy"  # final block: no rest day
        if kind is None:
            effort[z] = 0.0
            continue
        hour = 6.0 if kind in ("intervals", "tempo", "easy") else 7.5
        start_t = z * 86400.0 + hour * 3600.0 + _round(rnd() * 1800.0)
        a = _activity(kind, start_t, vol, rnd, s)
        acts.append(a)
        dur = a["t"][-1] - a["t"][0]
        f = {"intervals": 1.6, "tempo": 1.4, "long": 1.1, "longride": 0.9, "ride": 0.7, "easy": 0.8}[kind]
        effort[z] = dur / 60.0 * f
    daily = []
    acute = chronic = 30.0
    for z in range(start_day, end_day + 1):
        L = effort.get(z - 1, 0.0)
        acute += (L - acute) * (1.0 - math.exp(-1.0 / 7.0))
        chronic += (L - chronic) * (1.0 - math.exp(-1.0 / 42.0))
        imbalance = acute - chronic
        ln = 4.15 - 0.0025 * imbalance + 0.07 * _gauss(rnd)
        rhr = 48.0 + 0.03 * imbalance + 1.0 * _gauss(rnd)
        sleep = min(9.5, max(5.6, 7.9 + 0.4 * _gauss(rnd)))
        nap = 0.5 if ((z + 3) % 7 >= 5 and rnd() < 0.15) else None
        miss = rnd()
        if z == end_day:
            sleep = 5.8
            miss = 1.0
        elif z == end_day - 1:
            sleep = 6.4
        rec = {"date": z,
               "rmssd": math.exp(ln) if miss > 0.06 else None,
               "sdnn": None,
               "rhr": float(_round(rhr)) if miss < 0.03 or miss > 0.09 else None,
               "sleep": sleep if not (0.09 < miss < 0.11) else None,
               "nap": nap, "stages": None}
        if rec["sleep"] is not None:
            rec["stages"] = {"core": sleep * 0.6, "deep": sleep * 0.16, "rem": sleep * 0.24, "unspecified": 0.0}
        daily.append(rec)
    return acts, daily
