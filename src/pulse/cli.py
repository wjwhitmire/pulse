"""Command line: analyse activity files, the training-load series and readiness.

  pulse activity run.fit [--units mi] [--json]
  pulse load a.fit b.gpx c.tcx [--json]
  pulse readiness export.zip | export.xml | daily.csv [--day YYYY-MM-DD] [--json]
  pulse example [--end YYYY-MM-DD]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .analysis import analyze, settings_with
from .example import generate
from .fit import decode_fit
from .gpx import parse_gpx, parse_tcx
from .load import daily_loads, load_series
from .recovery import explain, parse_daily_csv, read_health, readiness
from .util import PulseError, day_str, parse_day

MAX_ACTIVITY = 50 * 1024 * 1024


def read_activities(path: str):
    p = Path(path)
    if p.stat().st_size > MAX_ACTIVITY:
        raise PulseError("size", f"{p.name}: over the 50 MB limit for activity files.")
    data = p.read_bytes()
    ext = p.suffix.lower()
    if ext == ".fit" or data[8:12] == b".FIT":
        return [decode_fit(data)]
    if ext == ".tcx":
        return parse_tcx(data)
    if ext == ".gpx":
        return parse_gpx(data)
    raise PulseError("type", f"{p.name}: unknown file type (expected .fit, .gpx or .tcx).")


def local_day(ts: float) -> int:
    lt = time.localtime(ts)
    return parse_day(f"{lt.tm_year:04d}-{lt.tm_mon:02d}-{lt.tm_mday:02d}")


def _fmt_dur(s):
    if s is None:
        return "-"
    s = int(round(s))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def _day_arg(text, flag):
    z = parse_day(text)
    if z is None:
        raise PulseError("date", f"{flag} must be a real date as YYYY-MM-DD, not {text!r}.")
    return z


def _settings(a):
    return settings_with({"max_hr": a.max_hr, "rest_hr": a.rest_hr, "units": a.units,
                          "zone_method": a.zones, "trimp_sex": a.trimp})


def main(argv=None):
    ap = argparse.ArgumentParser(prog="pulse", description="Private training log analysis.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("activity", "load", "readiness", "example"):
        sp = sub.add_parser(name)
        if name in ("activity", "load"):
            sp.add_argument("files", nargs="+")
        if name == "readiness":
            sp.add_argument("file")
            sp.add_argument("--day")
        if name == "example":
            sp.add_argument("--end")
        sp.add_argument("--max-hr", type=float)
        sp.add_argument("--rest-hr", type=float)
        sp.add_argument("--units", choices=("km", "mi"))
        sp.add_argument("--zones", choices=("hrr", "max"))
        sp.add_argument("--trimp", choices=("male", "female"))
        sp.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    s = _settings(a)
    try:
        if a.cmd == "activity":
            out = []
            for f in a.files:
                for act in read_activities(f):
                    r = analyze(act, s)
                    out.append(r)
                    if not a.json:
                        unit, size = ("mi", 1609.344) if s["units"] == "mi" else ("km", 1000.0)
                        print(f"{Path(f).name}: {act['sport']}, {r['distance'] / size:.2f} {unit}, moving {_fmt_dur(r['moving'])}, "
                              f"elapsed {_fmt_dur(r['elapsed'])}, load {r['load'] if r['load'] is None else round(r['load'], 1)}")
                        for b in r["fastest"]:
                            if b["time"] is not None:
                                print(f"  fastest {b['label']}: {_fmt_dur(b['time'])}")
            if a.json:
                print(json.dumps(out, indent=1))
        elif a.cmd == "load":
            items = []
            for f in a.files:
                for act in read_activities(f):
                    items.append((local_day(act["start"]), analyze(act, s)["load"]))
            daily = daily_loads(items)
            if not daily:
                raise PulseError("empty", "No activity with heart rate; no load to chart.")
            ser = load_series(daily, min(daily), max(daily), s["fit_tau"], s["fat_tau"])
            if a.json:
                print(json.dumps(ser))
            else:
                print("date,load,fitness,fatigue,form")
                for i, z in enumerate(ser["day"]):
                    print(f"{day_str(z)},{ser['load'][i]:.1f},{ser['fitness'][i]:.1f},{ser['fatigue'][i]:.1f},{ser['form'][i]:.1f}")
        elif a.cmd == "readiness":
            p = Path(a.file)
            if p.suffix.lower() == ".csv":
                if p.stat().st_size > 5 * 1024 * 1024:
                    raise PulseError("size", "CSV is over the 5 MB limit.")
                daily = parse_daily_csv(p.read_text(encoding="utf-8"))
            else:
                daily, _ = read_health(str(p))
            if not daily:
                raise PulseError("empty", "No HRV, resting HR or sleep records found.")
            day = _day_arg(a.day, "--day") if a.day else max(r["date"] for r in daily)
            r = readiness(daily, day, s)
            print(json.dumps(r, indent=1) if a.json else f"{day_str(day)}: {explain(r)}")
        else:
            end = _day_arg(a.end, "--end") if a.end else local_day(time.time())
            acts, daily = generate(end)
            print(f"Example athlete (synthetic): {len(acts)} activities, {len(daily)} days of recovery data.")
    except PulseError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except OSError as e:
        print(f"error: {e.strerror or e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
