"""Migration imports: a Strava bulk export (activities.csv plus activity files, some gzipped) and a
Whoop CSV export (physiological_cycles, sleeps, workouts, journal_entries).

Only measurements are imported. The services' own branded scores (their readiness score, their
day exertion score, their effort score) are not imported, because Pulse computes its own,
documented values from the measurements."""

from __future__ import annotations

from .recovery import blank_day
from .util import PulseError, num, parse_day

MAX_CSV = 50 * 1024 * 1024
MAX_ROWS = 50000


def parse_csv(text):
    """RFC 4180: quoted fields, doubled quotes, separators and line breaks inside quotes."""
    if len(text) > MAX_CSV:
        raise PulseError("size", "CSV is over the 50 MB limit.")
    if text.startswith("﻿"):
        text = text[1:]
    rows, row, field = [], [], []
    i, n = 0, len(text)
    quoted = False
    while i < n:
        c = text[i]
        if quoted:
            if c == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field.append('"')
                    i += 1
                else:
                    quoted = False
            else:
                field.append(c)
        elif c == '"':
            quoted = True
        elif c == ",":
            row.append("".join(field))
            field = []
        elif c == "\n" or c == "\r":
            row.append("".join(field))
            field = []
            if any(x != "" for x in row):
                rows.append(row)
                if len(rows) > MAX_ROWS + 1:
                    raise PulseError("rows", "The CSV has more than 50,000 rows.")
            row = []
            if c == "\r" and i + 1 < n and text[i + 1] == "\n":
                i += 1
        else:
            field.append(c)
        i += 1
    if field or row:
        row.append("".join(field))
        if any(x != "" for x in row):
            rows.append(row)
    return rows


def records(text):
    rows = parse_csv(text)
    if not rows:
        return [], []
    head = [h.strip().lower() for h in rows[0]]
    return head, rows[1:]


def _col(head, *names):
    for nm in names:
        if nm in head:
            return head.index(nm)
    return None


def _cell(r, k):
    return r[k].strip() if k is not None and k < len(r) else ""


STRAVA_SPORT = {"run": "run", "trail run": "run", "walk": "run", "hike": "run", "virtual run": "run",
                "ride": "ride", "virtual ride": "ride", "e-bike ride": "ride", "gravel ride": "ride",
                "mountain bike ride": "ride", "weight training": "strength"}


def strava_sport(t):
    return STRAVA_SPORT.get((t or "").strip().lower(), "other")


def strava_index(text):
    """activities.csv of a Strava bulk export. Returns entries keyed by the file path inside the zip
    (lower case), and summary rows for activities without a file (manual entries).
    Distance: when the file has two Distance columns, the later one (metres) is used; a single
    Distance column is read as kilometres."""
    head, body = records(text)
    if not head:
        raise PulseError("csv", "activities.csv is empty.")
    k_id = _col(head, "activity id")
    k_date = _col(head, "activity date")
    k_name = _col(head, "activity name")
    k_type = _col(head, "activity type")
    k_file = _col(head, "filename")
    k_gear = _col(head, "activity gear")
    k_el = _col(head, "elapsed time")
    dist_cols = [i for i, h in enumerate(head) if h == "distance"]
    if k_type is None or k_file is None:
        raise PulseError("csv", "This does not look like Strava's activities.csv (no Activity Type or Filename).")
    files, manual = {}, []
    for r in body:
        e = {"id": _cell(r, k_id), "name": _cell(r, k_name)[:200], "sport": strava_sport(_cell(r, k_type)),
             "type": _cell(r, k_type)[:60], "date": _cell(r, k_date), "gear": _cell(r, k_gear)[:120]}
        f = _cell(r, k_file)
        if f:
            files[f.lower()] = e
        else:
            dist = None
            if len(dist_cols) >= 2:
                dist = num(_cell(r, dist_cols[-1]).replace(",", ""))
            elif dist_cols:
                v = num(_cell(r, dist_cols[0]).replace(",", ""))
                dist = v * 1000.0 if v is not None else None
            e["distance"] = dist
            e["elapsed"] = num(_cell(r, k_el))
            manual.append(e)
    return {"files": files, "manual": manual}


def _bool(s):
    return s.strip().lower() in ("true", "yes", "1")


def _day_of(s):
    return parse_day(s[:10]) if s and len(s) >= 10 else None


# Plausible ranges; a value outside is a blank or a device error and is dropped, not imported.
WHOOP_RANGES = (("rmssd", 1.0, 400.0), ("rhr", 20.0, 150.0), ("wrist_temp", 20.0, 45.0), ("spo2", 50.0, 100.0),
                ("resp", 4.0, 60.0), ("sleep", 0.0, 20.0), ("in_bed", 0.0, 24.0))


def whoop_cycles(text):
    """physiological_cycles.csv: rMSSD (Whoop reports rMSSD), resting HR, skin temperature,
    blood oxygen, respiratory rate and sleep durations, dated by the wake time."""
    head, body = records(text)
    k = {nm: _col(head, nm) for nm in (
        "cycle start time", "wake onset", "sleep onset", "resting heart rate (bpm)", "heart rate variability (ms)",
        "skin temp (celsius)", "blood oxygen %", "respiratory rate (rpm)", "asleep duration (min)",
        "in bed duration (min)", "light sleep duration (min)", "deep (sws) duration (min)", "rem duration (min)")}
    if k["cycle start time"] is None:
        raise PulseError("csv", "physiological_cycles.csv has no 'Cycle start time' column.")
    out = []
    for r in body:
        z = _day_of(_cell(r, k["wake onset"])) or _day_of(_cell(r, k["cycle start time"]))
        if z is None:
            continue
        d = blank_day(z)
        d["rmssd"] = num(_cell(r, k["heart rate variability (ms)"]))
        d["rhr"] = num(_cell(r, k["resting heart rate (bpm)"]))
        d["wrist_temp"] = num(_cell(r, k["skin temp (celsius)"]))
        d["spo2"] = num(_cell(r, k["blood oxygen %"]))
        d["resp"] = num(_cell(r, k["respiratory rate (rpm)"]))
        a = num(_cell(r, k["asleep duration (min)"]))
        d["sleep"] = a / 60.0 if a is not None else None
        b = num(_cell(r, k["in bed duration (min)"]))
        d["in_bed"] = b / 60.0 if b is not None else None
        for key, lo, hi in WHOOP_RANGES:
            if d[key] is not None and not (lo <= d[key] <= hi):
                d[key] = None
        li, de, re_ = (num(_cell(r, k[x])) for x in ("light sleep duration (min)", "deep (sws) duration (min)", "rem duration (min)"))
        if li is not None or de is not None or re_ is not None:
            d["stages"] = {"core": (li or 0.0) / 60.0, "deep": (de or 0.0) / 60.0, "rem": (re_ or 0.0) / 60.0, "unspecified": 0.0}
        so, wo = _cell(r, k["sleep onset"]), _cell(r, k["wake onset"])
        if len(so) >= 16 and len(wo) >= 16:
            bm = int(so[11:13]) * 60 + int(so[14:16])
            d["bed_min"] = bm - 720 if bm >= 720 else bm + 720
            d["wake_min"] = int(wo[11:13]) * 60 + int(wo[14:16])
        out.append(d)
    return out


def whoop_naps(text):
    """sleeps.csv: nap hours per day (rows with Nap = true), dated by the nap's start."""
    head, body = records(text)
    k_on, k_nap, k_as = _col(head, "sleep onset"), _col(head, "nap"), _col(head, "asleep duration (min)")
    out = {}
    if k_nap is None:
        return out
    for r in body:
        if _bool(_cell(r, k_nap)):
            z = _day_of(_cell(r, k_on))
            a = num(_cell(r, k_as))
            if z is not None and a is not None:
                out[z] = out.get(z, 0.0) + a / 60.0
    return out


WHOOP_SPORT = {"running": "run", "walking": "run", "hiking": "run", "cycling": "ride", "spin": "ride",
               "mountain biking": "ride", "weightlifting": "strength", "functional fitness": "strength",
               "powerlifting": "strength"}


def whoop_workouts(text):
    """workouts.csv: summary-only activities (start, duration, sport, average and max HR,
    calories, distance, climb)."""
    head, body = records(text)
    k = {nm: _col(head, nm) for nm in ("workout start time", "duration (min)", "activity name", "energy burned (cal)",
                                         "max hr (bpm)", "average hr (bpm)", "distance (meters)", "altitude gain (meters)")}
    if k["workout start time"] is None:
        raise PulseError("csv", "workouts.csv has no 'Workout start time' column.")
    out = []
    for r in body:
        st = _cell(r, k["workout start time"])
        z = _day_of(st)
        mins = num(_cell(r, k["duration (min)"]))
        if z is None or not mins:
            continue
        nm = _cell(r, k["activity name"])
        out.append({"day": z, "start_text": st[:19], "name": nm[:200], "sport": WHOOP_SPORT.get(nm.strip().lower(), "other"),
                    "duration": mins * 60.0, "avg_hr": num(_cell(r, k["average hr (bpm)"])),
                    "max_hr": num(_cell(r, k["max hr (bpm)"])), "kcal": num(_cell(r, k["energy burned (cal)"])),
                    "distance": num(_cell(r, k["distance (meters)"])), "gain": num(_cell(r, k["altitude gain (meters)"]))})
    return out


def whoop_journal(text):
    """journal_entries.csv: {day: {question: answered yes}} dated by the cycle start."""
    head, body = records(text)
    k_d, k_q, k_y = _col(head, "cycle start time"), _col(head, "question text"), _col(head, "answered yes")
    if k_q is None or k_y is None:
        raise PulseError("csv", "journal_entries.csv needs 'Question text' and 'Answered yes' columns.")
    out = {}
    for r in body:
        z = _day_of(_cell(r, k_d))
        q = _cell(r, k_q)[:120]
        if z is None or not q:
            continue
        out.setdefault(z, {})[q] = _bool(_cell(r, k_y))
    return out
