"""Training load over time: daily load, fitness and fatigue (exponentially weighted), form,
and a descriptive, uncoupled this-week-versus-usual ratio."""

from __future__ import annotations

import math


def load_series(daily: dict, start_day: int, end_day: int, fit_tau=42.0, fat_tau=7.0):
    """daily maps day number to summed load. Returns a dict of equal-length lists.

    Banister impulse-response in its daily exponentially weighted form:
        F_t = F_{t-1} + (L_t - F_{t-1}) * (1 - exp(-1/tau)), tau = 42 (fitness) or 7 (fatigue)
    Form on day t = F_fit(t-1) - F_fat(t-1): the balance carried into the day, before its training.
    Ratio (descriptive, uncoupled) = mean load of days t-6..t / mean load of days t-27..t-7.
    """
    if end_day < start_day:
        return {"day": [], "load": [], "fitness": [], "fatigue": [], "form": [], "ratio": []}
    kf = 1.0 - math.exp(-1.0 / fit_tau)
    kd = 1.0 - math.exp(-1.0 / fat_tau)
    days, loads, fit, fat, form, ratio = [], [], [], [], [], []
    f = g = 0.0
    for z in range(start_day, end_day + 1):
        L = float(daily.get(z, 0.0))
        form.append(f - g)
        f = f + (L - f) * kf
        g = g + (L - g) * kd
        days.append(z)
        loads.append(L)
        fit.append(f)
        fat.append(g)
        k = len(loads) - 1
        if k >= 27:
            acute = sum(loads[k - 6:k + 1]) / 7.0
            usual = sum(loads[k - 27:k - 6]) / 21.0
            ratio.append(acute / usual if usual > 0 else None)
        else:
            ratio.append(None)
    return {"day": days, "load": loads, "fitness": fit, "fatigue": fat, "form": form, "ratio": ratio}


def daily_loads(items):
    """items: iterable of (day number, load or None). Returns {day: summed load}."""
    out = {}
    for z, L in items:
        if L is None:
            continue
        out[z] = out.get(z, 0.0) + L
    return out
