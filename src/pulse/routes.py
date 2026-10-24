"""Routes from the user's own tracks: repeat-route grouping, GPX export, personal segments
(start and end gates plus a corridor check, an independent design), elevation correction from a
user-supplied elevation point file, and histogram equalisation for the personal heatmap."""

from __future__ import annotations

import math
from bisect import bisect_left

from .util import PulseError, haversine, num, project_local

N_SIG = 50


def _positions(act, d):
    return [(i, act["lat"][i], act["lon"][i]) for i in range(len(d)) if act["lat"][i] is not None]


def signature(act, d):
    """Start, end, distance and N_SIG points evenly spaced by distance."""
    pos = _positions(act, d)
    if len(pos) < 2 or d[-1] <= 0:
        return None
    dd = [d[i] for i, _, _ in pos]
    total = dd[-1]
    pts = []
    for k in range(N_SIG):
        x = total * k / (N_SIG - 1)
        j = bisect_left(dd, x)
        if j <= 0:
            pts.append([pos[0][1], pos[0][2]])
        elif j >= len(dd):
            pts.append([pos[-1][1], pos[-1][2]])
        else:
            f = (x - dd[j - 1]) / (dd[j] - dd[j - 1]) if dd[j] > dd[j - 1] else 0.0
            pts.append([pos[j - 1][1] + f * (pos[j][1] - pos[j - 1][1]), pos[j - 1][2] + f * (pos[j][2] - pos[j - 1][2])])
    return {"start": pts[0], "end": pts[-1], "distance": total, "pts": pts}


def same_route(a, b, end_tol=200.0, dist_tol=0.10, mean_tol=100.0):
    if a is None or b is None:
        return False
    if haversine(*a["start"], *b["start"]) > end_tol or haversine(*a["end"], *b["end"]) > end_tol:
        return False
    if abs(a["distance"] - b["distance"]) > dist_tol * max(a["distance"], b["distance"]):
        return False
    tot = 0.0
    for p, q in zip(a["pts"], b["pts"]):
        tot += haversine(p[0], p[1], q[0], q[1])
    return tot / N_SIG <= mean_tol


def group_routes(sigs):
    """sigs: list of (id, signature). Greedy: each joins the first group whose first member matches.
    Same start and end, same direction, distance within 10 %, mean offset under 100 m."""
    groups = []
    for aid, sg in sigs:
        if sg is None:
            continue
        for g in groups:
            if same_route(g["sig"], sg):
                g["ids"].append(aid)
                break
        else:
            groups.append({"sig": sg, "ids": [aid]})
    return [g["ids"] for g in groups]


def _esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def _iso(t):
    from .util import day_str
    z = int(math.floor(t / 86400))
    sec = t - z * 86400
    h = int(sec // 3600)
    m = int(sec % 3600 // 60)
    s = sec - h * 3600 - m * 60
    return f"{day_str(z)}T{h:02d}:{m:02d}:{int(math.floor(s)):02d}Z"


def to_gpx(act, name=""):
    """GPX 1.1 track of an activity's positions, elevation, time and heart rate."""
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<gpx version="1.1" creator="Pulse" xmlns="http://www.topografix.com/GPX/1/1" '
           'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">',
           f"<trk><name>{_esc(name or act.get('name') or 'Activity')}</name><trkseg>"]
    for i, t in enumerate(act["t"]):
        la, lo = act["lat"][i], act["lon"][i]
        if la is None or lo is None:
            continue
        p = [f'<trkpt lat="{la:.7f}" lon="{lo:.7f}">']
        if act["ele"][i] is not None:
            p.append(f"<ele>{act['ele'][i]:.1f}</ele>")
        p.append(f"<time>{_iso(t)}</time>")
        if act["hr"][i] is not None:
            p.append(f"<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>{int(act['hr'][i])}</gpxtpx:hr>"
                     "</gpxtpx:TrackPointExtension></extensions>")
        p.append("</trkpt>")
        out.append("".join(p))
    out.append("</trkseg></trk></gpx>")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- personal segments

GATE_HALF = 25.0
CORRIDOR = 25.0
CORRIDOR_SHARE = 0.9


def _gate(xy, i):
    a = xy[max(0, i - 1)]
    b = xy[min(len(xy) - 1, i + 1)]
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.sqrt(dx * dx + dy * dy) or 1.0
    ux, uy = dx / L, dy / L  # direction of travel
    cx, cy = xy[i]
    return {"p": [cx - uy * GATE_HALF, cy + ux * GATE_HALF], "q": [cx + uy * GATE_HALF, cy - ux * GATE_HALF], "dir": [ux, uy]}


def make_segment(act, i0, i1, name=""):
    """A segment from samples i0..i1 of one activity: gates at both ends perpendicular to travel,
    and the reference line (positions in between, at most 300 points)."""
    idx = [i for i in range(i0, i1 + 1) if act["lat"][i] is not None]
    if len(idx) < 3:
        raise PulseError("segment", "Pick a stretch with at least three GPS points.")
    lat0, lon0 = act["lat"][idx[0]], act["lon"][idx[0]]
    xy = [project_local(act["lat"][i], act["lon"][i], lat0, lon0) for i in idx]
    step = max(1, len(idx) // 300)
    ref = [list(xy[k]) for k in range(0, len(xy), step)]
    if ref[-1] != list(xy[-1]):
        ref.append(list(xy[-1]))
    length = sum(math.sqrt((ref[k][0] - ref[k - 1][0]) ** 2 + (ref[k][1] - ref[k - 1][1]) ** 2) for k in range(1, len(ref)))
    return {"name": name, "origin": [lat0, lon0], "start": _gate(xy, 0), "end": _gate(xy, len(xy) - 1),
            "ref": ref, "length": length}


def _cross(a, b, g):
    """Fraction along a->b where it crosses gate g in the direction of travel, else None."""
    p, q = g["p"], g["q"]
    rx, ry = b[0] - a[0], b[1] - a[1]
    sx, sy = q[0] - p[0], q[1] - p[1]
    den = rx * sy - ry * sx
    if den == 0:
        return None
    t = ((p[0] - a[0]) * sy - (p[1] - a[1]) * sx) / den
    u = ((p[0] - a[0]) * ry - (p[1] - a[1]) * rx) / den
    if not (0.0 <= t <= 1.0 and 0.0 <= u <= 1.0):
        return None
    if rx * g["dir"][0] + ry * g["dir"][1] <= 0:
        return None
    return t


def _dist_to_poly(pt, ref):
    best = None
    for k in range(1, len(ref)):
        ax, ay = ref[k - 1]
        bx, by = ref[k]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        f = 0.0 if L2 == 0 else max(0.0, min(1.0, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / L2))
        ex, ey = ax + f * dx - pt[0], ay + f * dy - pt[1]
        d = math.sqrt(ex * ex + ey * ey)
        if best is None or d < best:
            best = d
    return best


def match_segment(seg, act):
    """Efforts on a segment: an ordered start-gate crossing, then end-gate crossing, with at least
    90 % of the points in between inside a 25 m corridor of the reference line. Elapsed time
    between interpolated crossing times."""
    lat0, lon0 = seg["origin"]
    idx = [i for i in range(len(act["t"])) if act["lat"][i] is not None]
    xy = [project_local(act["lat"][i], act["lon"][i], lat0, lon0) for i in idx]
    out = []
    k = 1
    while k < len(xy):
        f = _cross(xy[k - 1], xy[k], seg["start"])
        if f is None:
            k += 1
            continue
        ts = act["t"][idx[k - 1]] + f * (act["t"][idx[k]] - act["t"][idx[k - 1]])
        j = k + 1
        found = None
        while j < len(xy):
            g = _cross(xy[j - 1], xy[j], seg["end"])
            if g is not None:
                found = (j, g)
                break
            if _cross(xy[j - 1], xy[j], seg["start"]) is not None:
                break
            j += 1
        if found is None:
            k += 1
            continue
        j, g = found
        inside = [_dist_to_poly(xy[m], seg["ref"]) <= CORRIDOR for m in range(k, j)]
        if inside and sum(inside) >= CORRIDOR_SHARE * len(inside):
            te = act["t"][idx[j - 1]] + g * (act["t"][idx[j]] - act["t"][idx[j - 1]])
            out.append({"start": ts, "elapsed": te - ts})
        k = j + 1
    return out


# ---------------------------------------------------------------- elevation correction

MAX_DEM = 200000
CELL = 0.002  # degrees for the bucket grid


def parse_dem(text):
    """CSV of lat, lon, elevation (m), header optional, comma, tab or semicolon separated."""
    pts = []
    for n, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        sep = "\t" if "\t" in line else (";" if ";" in line else ",")
        c = [x.strip() for x in line.split(sep)]
        if len(c) < 3:
            raise PulseError("dem", f"Row {n}: expected lat, lon, elevation.")
        la, lo, el = num(c[0]), num(c[1]), num(c[2])
        if la is None or lo is None or el is None:
            if n == 1:
                continue  # header
            raise PulseError("dem", f"Row {n}: lat, lon and elevation must be numbers.")
        if abs(la) > 90 or abs(lo) > 180:
            raise PulseError("dem", f"Row {n}: coordinates out of range.")
        pts.append([la, lo, el])
        if len(pts) > MAX_DEM:
            raise PulseError("rows", "The elevation file has more than 200,000 points.")
    if not pts:
        raise PulseError("dem", "No elevation points found.")
    return pts


def correct_elevation(pts, act, radius=150.0, k=4):
    """Inverse-distance-squared mean of the k nearest elevation points within `radius` metres.
    Samples with no point nearby keep their recorded elevation."""
    grid = {}
    for la, lo, el in pts:
        grid.setdefault((int(math.floor(la / CELL)), int(math.floor(lo / CELL))), []).append((la, lo, el))
    out = []
    for i in range(len(act["t"])):
        la, lo = act["lat"][i], act["lon"][i]
        if la is None:
            out.append(act["ele"][i])
            continue
        gi, gj = int(math.floor(la / CELL)), int(math.floor(lo / CELL))
        cand = []
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for p in grid.get((gi + di, gj + dj), ()):
                    dd = haversine(la, lo, p[0], p[1])
                    if dd <= radius:
                        cand.append((dd, p[2]))
        if not cand:
            out.append(act["ele"][i])
            continue
        cand.sort()
        near = cand[:k]
        if near[0][0] < 0.01:
            out.append(near[0][1])
            continue
        w = [1.0 / (dd * dd) for dd, _ in near]
        out.append(sum(wi * e for wi, (_, e) in zip(w, near)) / sum(w))
    return out


def equalize(counts):
    """Histogram equalisation of nonzero pixel counts to (0, 1]; zero stays zero."""
    vals = sorted(set(c for c in counts if c > 0))
    if not vals:
        return [0.0] * len(counts)
    freq = {}
    for c in counts:
        if c > 0:
            freq[c] = freq.get(c, 0) + 1
    total = sum(freq.values())
    cdf = {}
    acc = 0
    for v in vals:
        acc += freq[v]
        cdf[v] = acc / total
    return [cdf[c] if c > 0 else 0.0 for c in counts]
