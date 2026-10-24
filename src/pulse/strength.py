"""Strength log: volume load, estimated one-rep max, personal records and trends."""

from __future__ import annotations


def epley(load, reps):
    """Epley 1985: 1RM = w x (1 + r/30); a single is its own 1RM."""
    if load is None or not reps or reps < 1:
        return None
    return float(load) if reps == 1 else load * (1.0 + reps / 30.0)


def brzycki(load, reps):
    """Brzycki 1993: 1RM = w x 36 / (37 - r), defined for r < 37."""
    if load is None or not reps or reps < 1 or reps >= 37:
        return None
    return load * 36.0 / (37.0 - reps)


def session_stats(session):
    """session: {"date": day, "name": str, "sets": [{"exercise", "reps", "load"}]} (load in kg)."""
    vol = 0.0
    per = {}
    for st in session.get("sets", []):
        ex = (st.get("exercise") or "").strip()
        reps = st.get("reps") or 0
        load = st.get("load") or 0.0
        if not ex or reps <= 0:
            continue
        v = reps * load
        vol += v
        e = per.setdefault(ex, {"sets": 0, "reps": 0, "volume": 0.0, "top_load": 0.0, "e1rm": 0.0, "brzycki": 0.0})
        e["sets"] += 1
        e["reps"] += reps
        e["volume"] += v
        e["top_load"] = max(e["top_load"], load)
        e["e1rm"] = max(e["e1rm"], epley(load, reps) or 0.0)
        e["brzycki"] = max(e["brzycki"], brzycki(load, reps) or 0.0)
    return {"volume": vol, "exercises": per}


def records(sessions):
    """Per exercise: best estimated 1RM (Epley), heaviest load, best single-set volume, each with
    the date it was set, plus a per-session trend of the best e1RM."""
    out = {}
    for ses in sorted(sessions, key=lambda x: x["date"]):
        for st in ses.get("sets", []):
            ex = (st.get("exercise") or "").strip()
            reps = st.get("reps") or 0
            load = st.get("load") or 0.0
            if not ex or reps <= 0:
                continue
            r = out.setdefault(ex, {"e1rm": 0.0, "e1rm_date": None, "load": 0.0, "load_date": None,
                                    "set_volume": 0.0, "set_volume_date": None, "trend": []})
            e = epley(load, reps) or 0.0
            if e > r["e1rm"]:
                r["e1rm"], r["e1rm_date"] = e, ses["date"]
            if load > r["load"]:
                r["load"], r["load_date"] = load, ses["date"]
            if reps * load > r["set_volume"]:
                r["set_volume"], r["set_volume_date"] = reps * load, ses["date"]
        for ex, e in session_stats(ses)["exercises"].items():
            out[ex]["trend"].append([ses["date"], e["e1rm"]])
    return out
