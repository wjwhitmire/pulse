"""GPX 1.1 and Garmin TCX parsing with the standard library ElementTree.

Any document that carries a DOCTYPE or ENTITY declaration is refused before parsing, so no
entity can be defined and none is ever expanded (no billion-laughs, no external entities).
Only UTF-8 (with or without a byte order mark) is accepted.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from .util import PulseError, num, parse_time

MAX_BYTES = 50 * 1024 * 1024
_DTD = re.compile(r"<!DOCTYPE|<!ENTITY", re.I)


def _text_of(data) -> str:
    if isinstance(data, str):
        text = data
    else:
        raw = bytes(data)
        if len(raw) > MAX_BYTES:
            raise PulseError("size", "File is over the 50 MB limit.")
        if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
            raise PulseError("encoding", "UTF-16 files are not supported; save the file as UTF-8.")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise PulseError("encoding", "The file is not valid UTF-8 text.") from None
    if len(text) > MAX_BYTES:
        raise PulseError("size", "File is over the 50 MB limit.")
    if text.startswith("﻿"):
        text = text[1:]
    return text


def secure_root(data):
    text = _text_of(data)
    if _DTD.search(text):
        raise PulseError("doctype", "The file declares a DOCTYPE or ENTITY. Refused for safety.")
    try:
        return ET.fromstring(text)
    except ET.ParseError as e:
        raise PulseError("xml", f"The file is not well-formed XML ({e}).") from None


def local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def kids(el, name):
    return [c for c in el if local(c.tag) == name]


def kid(el, name):
    for c in el:
        if local(c.tag) == name:
            return c
    return None


def text(el) -> str:
    """All descendant text joined, like DOM textContent."""
    return "".join(el.itertext()) if el is not None else ""


def first_desc(el, names):
    """First descendant (document order, excluding el) whose local name is in names."""
    for d in el.iter():
        if d is not el and local(d.tag) in names:
            return d
    return None


def sport_of(s: str) -> str:
    s = (s or "").strip().lower()
    if "run" in s or "walk" in s or "hik" in s:
        return "run"
    if "bik" in s or "cycl" in s or "ride" in s:
        return "ride"
    return "other"


def new_activity(source, name="", sport="other"):
    return {"source": source, "name": name, "sport": sport, "start": None,
            "t": [], "lat": [], "lon": [], "ele": [], "hr": [], "cad": [], "pwr": [], "dist": [],
            "laps": [], "session": None, "pauses": [], "rr": [], "warnings": []}


def _push(act, t, lat, lon, ele, hr, cad, pwr, dist):
    if t is None:
        act["_untimed"] = act.get("_untimed", 0) + 1
        return
    if act["t"] and t < act["t"][-1]:
        act["_backwards"] = act.get("_backwards", 0) + 1
        return
    if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
        lat = lon = None
    for k, v in zip(("t", "lat", "lon", "ele", "hr", "cad", "pwr", "dist"), (t, lat, lon, ele, hr, cad, pwr, dist)):
        act[k].append(v)


def _finish(act):
    if act.pop("_untimed", 0):
        act["warnings"].append("points without a time were skipped")
    if act.pop("_backwards", 0):
        act["warnings"].append("points out of time order were skipped")
    if len(act["t"]) < 2:
        raise PulseError("notimes", "Fewer than two points with a valid time; nothing to analyse.")
    act["start"] = act["t"][0]
    return act


def parse_gpx(data) -> list:
    root = secure_root(data)
    if local(root.tag) != "gpx":
        raise PulseError("notgpx", "Not a GPX file (root element is not <gpx>).")
    name = ""
    typ = ""
    md = kid(root, "metadata")
    if md is not None and kid(md, "name") is not None:
        name = text(kid(md, "name")).strip()
    act = new_activity("gpx")
    for trk in kids(root, "trk"):
        if kid(trk, "name") is not None and not name:
            name = text(kid(trk, "name")).strip()
        if kid(trk, "type") is not None and not typ:
            typ = text(kid(trk, "type"))
        for seg in kids(trk, "trkseg"):
            for p in kids(seg, "trkpt"):
                ext = kid(p, "extensions")
                hr = cad = pwr = None
                if ext is not None:
                    e = first_desc(ext, ("hr", "heartrate"))
                    hr = num(text(e)) if e is not None else None
                    e = first_desc(ext, ("cad", "cadence"))
                    cad = num(text(e)) if e is not None else None
                    e = first_desc(ext, ("power", "watts"))
                    pwr = num(text(e)) if e is not None else None
                ele = kid(p, "ele")
                tm = kid(p, "time")
                _push(act, parse_time(text(tm)) if tm is not None else None,
                      num(p.get("lat")), num(p.get("lon")),
                      num(text(ele)) if ele is not None else None, hr, cad, pwr, None)
    act["name"] = name[:200]
    act["sport"] = sport_of(typ)
    return [_finish(act)]


def parse_tcx(data) -> list:
    root = secure_root(data)
    if local(root.tag) != "TrainingCenterDatabase":
        raise PulseError("nottcx", "Not a TCX file (root element is not <TrainingCenterDatabase>).")
    out = []
    acts = kid(root, "Activities")
    for a in (kids(acts, "Activity") if acts is not None else []):
        act = new_activity("tcx", "", sport_of(a.get("Sport") or ""))
        notes = kid(a, "Notes")
        if notes is not None:
            act["name"] = text(notes).strip()[:200]
        for lap in kids(a, "Lap"):
            def lv(name, sub=None):
                e = kid(lap, name)
                if e is not None and sub:
                    e = kid(e, sub)
                return num(text(e)) if e is not None else None
            tt = lv("TotalTimeSeconds")
            act["laps"].append({"start": parse_time(lap.get("StartTime")), "elapsed": tt, "timer": tt,
                                "distance": lv("DistanceMeters"), "avg_hr": lv("AverageHeartRateBpm", "Value"),
                                "max_hr": lv("MaximumHeartRateBpm", "Value")})
            for trk in kids(lap, "Track"):
                for p in kids(trk, "Trackpoint"):
                    pos = kid(p, "Position")
                    lat = lon = None
                    if pos is not None:
                        e = kid(pos, "LatitudeDegrees")
                        lat = num(text(e)) if e is not None else None
                        e = kid(pos, "LongitudeDegrees")
                        lon = num(text(e)) if e is not None else None

                    def pv(name, sub=None):
                        e = kid(p, name)
                        if e is not None and sub:
                            e = kid(e, sub)
                        return num(text(e)) if e is not None else None
                    cad = pv("Cadence")
                    pwr = None
                    ext = kid(p, "Extensions")
                    if ext is not None:
                        e = first_desc(ext, ("Watts",))
                        pwr = num(text(e)) if e is not None else None
                        if cad is None:
                            e = first_desc(ext, ("RunCadence",))
                            cad = num(text(e)) if e is not None else None
                    tm = kid(p, "Time")
                    _push(act, parse_time(text(tm)) if tm is not None else None, lat, lon,
                          pv("AltitudeMeters"), pv("HeartRateBpm", "Value"), cad, pwr, pv("DistanceMeters"))
        out.append(_finish(act))
    if not out:
        raise PulseError("notimes", "The TCX file has no activities.")
    return out
