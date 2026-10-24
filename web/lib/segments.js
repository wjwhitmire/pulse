// PulseSegments: segment definition (start gate, end gate, corridor) and
// effort matching with gate-crossing interpolation and an ordered corridor
// check that rejects shortcuts. Pure functions. Track points are
// { lat, lon, t } with t in seconds; elapsed times come back in seconds.
var PulseSegments = (function () {
  "use strict";

  var R = 6371008.8;
  var MAX_POINTS = 500000;
  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function rad(d) { return d * Math.PI / 180; }
  function haversine(a, b) {
    var p1 = rad(a.lat), p2 = rad(b.lat), dp = p2 - p1, dl = rad(b.lon - a.lon);
    var s1 = Math.sin(dp / 2), s2 = Math.sin(dl / 2);
    var h = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  // Local tangent-plane projection (metres). Accurate to well under 0.1 percent
  // within a few km of the origin, which covers any segment.
  function projector(lat0, lon0) {
    var k = rad(1) * R, c = Math.cos(rad(lat0));
    return function (p) { return [(p.lon - lon0) * k * c, (p.lat - lat0) * k]; };
  }
  function validPt(p) {
    return p && typeof p === "object" && typeof p.lat === "number" && typeof p.lon === "number" &&
      isFinite(p.lat) && isFinite(p.lon) && p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180;
  }
  function checkTrack(track, needTime) {
    if (!Array.isArray(track)) throw err("input", "Track must be an array of points.");
    if (track.length > MAX_POINTS) throw err("size", "Track has more than " + MAX_POINTS + " points.");
    var out = [];
    for (var i = 0; i < track.length; i++) {
      var p = track[i];
      if (!validPt(p)) continue;
      if (needTime && (typeof p.t !== "number" || !isFinite(p.t))) continue;
      if (needTime && out.length && p.t < out[out.length - 1].t) continue;
      out.push({ lat: p.lat, lon: p.lon, t: needTime ? p.t : null });
    }
    return out;
  }
  function num(o, k, d) { return o && Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === "number" && isFinite(o[k]) && o[k] > 0 ? o[k] : d; }

  // Resample a polyline every `step` metres (keeps endpoints).
  function resample(pts, step) {
    var out = [{ lat: pts[0].lat, lon: pts[0].lon }], carry = 0;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i], d = haversine(a, b), pos = step - carry;
      while (d > 0 && pos <= d) {
        var f = pos / d;
        out.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
        pos += step;
      }
      carry = d - (pos - step);
      if (out.length > 20000) throw err("size", "Segment is too long.");
    }
    var last = pts[pts.length - 1], tail = out[out.length - 1];
    if (haversine(last, tail) > step * 0.25) out.push({ lat: last.lat, lon: last.lon });
    else out[out.length - 1] = { lat: last.lat, lon: last.lon };
    return out;
  }

  // Unit direction (east, north) of the polyline at an end, averaged over the
  // first or last ~`span` metres so a single noisy point does not tilt the gate.
  function direction(pts, atEnd, span) {
    var proj = projector(pts[0].lat, pts[0].lon);
    var n = pts.length, i, a, b, acc = 0;
    if (!atEnd) { a = pts[0]; b = pts[1]; for (i = 1; i < n; i++) { acc += haversine(pts[i - 1], pts[i]); b = pts[i]; if (acc >= span) break; } }
    else { b = pts[n - 1]; a = pts[n - 2]; for (i = n - 2; i >= 0; i--) { acc += haversine(pts[i], pts[i + 1]); a = pts[i]; if (acc >= span) break; } }
    var pa = proj(a), pb = proj(b), dx = pb[0] - pa[0], dy = pb[1] - pa[1], L = Math.hypot(dx, dy);
    if (!(L > 0)) throw err("degenerate", "Segment has no length at one end.");
    return [dx / L, dy / L];
  }

  // Build a segment from points[startIdx..endIdx] of a track.
  // opts: gateHalfWidth (m, default 25), corridor (m, default 30), step (m, default 10).
  function defineSegment(track, startIdx, endIdx, opts) {
    var pts = checkTrack(track, false);
    var a = typeof startIdx === "number" ? Math.max(0, Math.floor(startIdx)) : 0;
    var b = typeof endIdx === "number" ? Math.min(pts.length - 1, Math.floor(endIdx)) : pts.length - 1;
    if (!(b > a)) throw err("range", "Segment needs at least two points.");
    var sub = pts.slice(a, b + 1);
    var length = 0;
    for (var i = 1; i < sub.length; i++) length += haversine(sub[i - 1], sub[i]);
    var gate = num(opts, "gateHalfWidth", 25), corridor = num(opts, "corridor", 30), step = num(opts, "step", 10);
    if (length < Math.max(50, 2 * step)) throw err("short", "Segment must be at least 50 m long.");
    var line = resample(sub, step);
    return {
      version: 1,
      start: { lat: sub[0].lat, lon: sub[0].lon, dir: direction(line, false, 30) },
      end: { lat: sub[sub.length - 1].lat, lon: sub[sub.length - 1].lon, dir: direction(line, true, 30) },
      gateHalfWidth: gate,
      corridor: corridor,
      length: length,
      line: line.map(function (p) { return [p.lat, p.lon]; })
    };
  }

  function checkSegment(seg) {
    if (!seg || typeof seg !== "object" || !Array.isArray(seg.line) || seg.line.length < 2 || seg.line.length > 20001) throw err("segment", "Not a segment definition.");
    var line = [];
    for (var i = 0; i < seg.line.length; i++) {
      var q = seg.line[i];
      if (!Array.isArray(q) || !validPt({ lat: q[0], lon: q[1] })) throw err("segment", "Segment line has a bad point.");
      line.push({ lat: q[0], lon: q[1] });
    }
    function gate(g) {
      if (!g || !validPt(g) || !Array.isArray(g.dir) || g.dir.length !== 2 || !isFinite(g.dir[0]) || !isFinite(g.dir[1])) throw err("segment", "Segment gate is malformed.");
      var L = Math.hypot(g.dir[0], g.dir[1]);
      if (!(L > 0)) throw err("segment", "Segment gate has no direction.");
      return { lat: g.lat, lon: g.lon, dir: [g.dir[0] / L, g.dir[1] / L] };
    }
    var length = typeof seg.length === "number" && seg.length > 0 ? seg.length : 0;
    if (!length) for (i = 1; i < line.length; i++) length += haversine(line[i - 1], line[i]);
    return { start: gate(seg.start), end: gate(seg.end), gateHalfWidth: num(seg, "gateHalfWidth", 25), corridor: num(seg, "corridor", 30), length: length, line: line };
  }

  // Where does track step p->q cross a gate? The gate is the line through the
  // gate point perpendicular to its direction, limited to +/- halfWidth.
  // Crossing must go in the gate direction. Returns the fraction u along p->q.
  function crossing(P, Q, G, dir, half) {
    var sp = (P[0] - G[0]) * dir[0] + (P[1] - G[1]) * dir[1];
    var sq = (Q[0] - G[0]) * dir[0] + (Q[1] - G[1]) * dir[1];
    if (!(sp < 0 && sq >= 0)) return null;
    var u = sp / (sp - sq);
    var x = P[0] + (Q[0] - P[0]) * u, y = P[1] + (Q[1] - P[1]) * u;
    var lateral = Math.abs((x - G[0]) * -dir[1] + (y - G[1]) * dir[0]);
    return lateral <= half ? u : null;
  }

  function distToSeg(X, A, B) {
    var dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    var u = L2 > 0 ? ((X[0] - A[0]) * dx + (X[1] - A[1]) * dy) / L2 : 0;
    u = Math.max(0, Math.min(1, u));
    return Math.hypot(X[0] - A[0] - u * dx, X[1] - A[1] - u * dy);
  }

  // Find every effort on a track. opts: maxEfforts (default 50),
  // minLengthRatio (default 0.9), maxLengthRatio (default 2.5).
  function matchEfforts(segment, track, opts) {
    var seg = checkSegment(segment);
    var pts = checkTrack(track, true);
    var result = { efforts: [], rejected: [] };
    if (pts.length < 2) return result;
    var proj = projector(seg.start.lat, seg.start.lon);
    var T = pts.map(proj), L = seg.line.map(proj);
    var S = proj(seg.start), E = proj(seg.end);
    var half = seg.gateHalfWidth, cor = seg.corridor;
    var maxEff = Math.min(500, Math.floor(num(opts, "maxEfforts", 50)));
    var minRatio = num(opts, "minLengthRatio", 0.9), maxRatio = num(opts, "maxLengthRatio", 2.5);

    // Cheap bounding-box reject: the track must come near both gates.
    var near = function (G) { for (var i = 0; i < T.length; i++) if (Math.abs(T[i][0] - G[0]) <= half + cor && Math.abs(T[i][1] - G[1]) <= half + cor) return true; return false; };
    if (!near(S) || !near(E)) return result;

    var starts = [], ends = [];
    for (var i = 0; i + 1 < T.length; i++) {
      var us = crossing(T[i], T[i + 1], S, seg.start.dir, half);
      if (us !== null) starts.push({ i: i, u: us });
      var ue = crossing(T[i], T[i + 1], E, seg.end.dir, half);
      if (ue !== null) ends.push({ i: i, u: ue });
    }
    function tAt(c) { return pts[c.i].t + (pts[c.i + 1].t - pts[c.i].t) * c.u; }
    function after(e, s) { return e.i > s.i || (e.i === s.i && e.u > s.u); }

    var lastEndPos = -1;
    for (var k = 0; k < starts.length && result.efforts.length < maxEff; k++) {
      var s = starts[k];
      if (s.i + s.u <= lastEndPos) continue; // overlaps the previous effort
      var reason = null, effort = null;
      for (var m = 0; m < ends.length; m++) {
        var e = ends[m];
        if (!after(e, s)) continue;
        // If the athlete crosses the start gate again before reaching the end,
        // the later crossing owns the effort.
        var nextStart = starts[k + 1];
        if (nextStart && after(e, nextStart)) { reason = "restarted"; break; }
        var chk = verifyBetween(T, s, e, L, cor);
        if (!chk.ok) { reason = chk.reason; break; }
        var dist = chk.distance;
        if (dist < seg.length * minRatio) { reason = "too-short"; break; }
        if (dist > seg.length * maxRatio) { reason = "too-long"; break; }
        var t0 = tAt(s), t1 = tAt(e);
        effort = { startIndex: s.i, endIndex: e.i + 1, startTime: t0, endTime: t1, elapsed: t1 - t0, distance: dist };
        break;
      }
      if (effort) { result.efforts.push(effort); lastEndPos = effort.endIndex - 1 + 1e-9; }
      else result.rejected.push({ startIndex: s.i, reason: reason || "no-end-gate" });
    }
    return result;
  }

  // Corridor check between a start crossing s and end crossing e:
  // 1. every track point between them lies within the corridor of the segment;
  // 2. every segment checkpoint is reached, in order, by the track (within the
  //    corridor). Point 2 is what rejects shortcuts that skip part of the line.
  function verifyBetween(T, s, e, L, cor) {
    var i, j;
    function lerp(c) { var a = T[c.i], b = T[c.i + 1]; return [a[0] + (b[0] - a[0]) * c.u, a[1] + (b[1] - a[1]) * c.u]; }
    var sub = [lerp(s)];
    for (i = s.i + 1; i <= e.i; i++) sub.push(T[i]);
    sub.push(lerp(e));
    var dist = 0;
    for (i = 1; i < sub.length; i++) dist += Math.hypot(sub[i][0] - sub[i - 1][0], sub[i][1] - sub[i - 1][1]);
    for (i = 0; i < sub.length; i++) {
      var best = Infinity;
      for (j = 1; j < L.length && best > cor; j++) best = Math.min(best, distToSeg(sub[i], L[j - 1], L[j]));
      if (best > cor) return { ok: false, reason: "left-corridor" };
    }
    var at = 0; // index into sub where the previous checkpoint was reached
    for (j = 0; j < L.length; j++) {
      var found = -1;
      for (i = Math.max(1, at); i < sub.length; i++) {
        if (distToSeg(L[j], sub[i - 1], sub[i]) <= cor) { found = i; break; }
      }
      if (found < 0) return { ok: false, reason: "shortcut" };
      at = found;
    }
    return { ok: true, distance: dist };
  }

  function bestEffort(segment, track, opts) {
    var r = matchEfforts(segment, track, opts), best = null;
    for (var i = 0; i < r.efforts.length; i++) if (!best || r.efforts[i].elapsed < best.elapsed) best = r.efforts[i];
    return best;
  }

  return Object.freeze({
    haversine: haversine,
    defineSegment: defineSegment,
    matchEfforts: matchEfforts,
    bestEffort: bestEffort
  });
})();
