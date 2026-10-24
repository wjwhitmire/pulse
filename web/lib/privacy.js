// PulsePrivacy: privacy zones and track trimming. Applied before any track
// leaves the device. Zones are circles around saved places plus the first and
// last N metres of every activity (both along the track and as a circle
// around the actual start and end point, so a route that doubles back past
// home is still cut). Pure functions.
var PulsePrivacy = (function () {
  "use strict";

  var R = 6371008.8;
  var MAX_POINTS = 500000, MAX_ZONES = 1000, MAX_RADIUS = 50000;
  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function rad(d) { return d * Math.PI / 180; }
  function haversine(a, b) {
    var p1 = rad(a.lat), p2 = rad(b.lat), dp = p2 - p1, dl = rad(b.lon - a.lon);
    var s1 = Math.sin(dp / 2), s2 = Math.sin(dl / 2);
    var h = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  function validPt(p) {
    return p !== null && typeof p === "object" && typeof p.lat === "number" && typeof p.lon === "number" &&
      isFinite(p.lat) && isFinite(p.lon) && p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180;
  }
  function own(o, k) { return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k); }

  var DEFAULT_RADIUS = 200;

  // places: [{ lat, lon, radius? }] -> normalized zones. Bad entries throw:
  // silently dropping a zone would leak the place it was meant to hide.
  function buildZones(places, opts) {
    if (!Array.isArray(places)) throw err("input", "Places must be an array.");
    if (places.length > MAX_ZONES) throw err("size", "More than " + MAX_ZONES + " privacy zones.");
    var def = own(opts, "radius") && typeof opts.radius === "number" && opts.radius > 0 ? opts.radius : DEFAULT_RADIUS;
    var out = [];
    for (var i = 0; i < places.length; i++) {
      var p = places[i];
      if (!validPt(p)) throw err("zone", "Privacy zone " + (i + 1) + " has no valid latitude and longitude.");
      var r = own(p, "radius") ? p.radius : def;
      if (typeof r !== "number" || !isFinite(r) || r <= 0) throw err("zone", "Privacy zone " + (i + 1) + " has an invalid radius.");
      out.push({ lat: p.lat, lon: p.lon, radius: Math.min(r, MAX_RADIUS) });
    }
    return out;
  }

  function inZone(p, z, margin) { return haversine(p, z) <= z.radius + margin; }
  function insideAny(p, zones, margin) {
    for (var i = 0; i < zones.length; i++) if (inZone(p, zones[i], margin || 0)) return true;
    return false;
  }

  // Trim a track. opts: zones (from buildZones or raw places), trimStart and
  // trimEnd (m, default 200), margin (m, extra radius, default 5 to absorb
  // rounding in other implementations that re-check).
  // Returns { points, runs, removed, kept } where runs are contiguous pieces:
  // draw each run separately so no line is drawn across a removed zone.
  function trimTrack(points, opts) {
    if (!Array.isArray(points)) throw err("input", "Track must be an array of points.");
    if (points.length > MAX_POINTS) throw err("size", "Track has more than " + MAX_POINTS + " points.");
    var zones = own(opts, "zones") ? buildZones(opts.zones) : [];
    var trimStart = own(opts, "trimStart") ? opts.trimStart : DEFAULT_RADIUS;
    var trimEnd = own(opts, "trimEnd") ? opts.trimEnd : DEFAULT_RADIUS;
    var margin = own(opts, "margin") ? opts.margin : 5;
    if (typeof trimStart !== "number" || !(trimStart >= 0) || typeof trimEnd !== "number" || !(trimEnd >= 0) || typeof margin !== "number" || !(margin >= 0) || !isFinite(margin)) {
      throw err("input", "Trim distances must be zero or positive numbers.");
    }
    var valid = [], i;
    for (i = 0; i < points.length; i++) if (validPt(points[i])) valid.push(points[i]);
    var n = valid.length;
    var keep = new Array(n);
    for (i = 0; i < n; i++) keep[i] = true;
    if (n) {
      var all = zones.slice();
      if (trimStart > 0) all.push({ lat: valid[0].lat, lon: valid[0].lon, radius: trimStart });
      if (trimEnd > 0) all.push({ lat: valid[n - 1].lat, lon: valid[n - 1].lon, radius: trimEnd });
      // Along-track cut from each end.
      var d = 0;
      for (i = 0; i < n && trimStart > 0; i++) {
        if (i) d += haversine(valid[i - 1], valid[i]);
        if (d > trimStart + margin) break;
        keep[i] = false;
      }
      d = 0;
      for (i = n - 1; i >= 0 && trimEnd > 0; i--) {
        if (i < n - 1) d += haversine(valid[i + 1], valid[i]);
        if (d > trimEnd + margin) break;
        keep[i] = false;
      }
      for (i = 0; i < n; i++) if (keep[i] && insideAny(valid[i], all, margin)) keep[i] = false;
    }
    var kept = [], runs = [], run = null;
    for (i = 0; i < n; i++) {
      if (keep[i]) {
        var p = valid[i], q = { lat: p.lat, lon: p.lon };
        // Copy only known numeric fields; anything else (names, notes) stays home.
        if (typeof p.t === "number" && isFinite(p.t)) q.t = p.t;
        if (typeof p.ele === "number" && isFinite(p.ele)) q.ele = p.ele;
        if (typeof p.hr === "number" && isFinite(p.hr)) q.hr = p.hr;
        kept.push(q);
        if (!run) { run = []; runs.push(run); }
        run.push(q);
      } else run = null;
    }
    return { points: kept, runs: runs, kept: kept.length, removed: points.length - kept.length };
  }

  // Independent re-check (the hub runs the same rule): returns indices of
  // points inside any zone. Empty means the track is clean.
  function violations(points, zones, margin) {
    if (!Array.isArray(points)) throw err("input", "Track must be an array of points.");
    var zs = buildZones(zones), bad = [];
    for (var i = 0; i < points.length && i < MAX_POINTS; i++) {
      if (!validPt(points[i])) { bad.push(i); continue; }
      if (insideAny(points[i], zs, margin || 0)) bad.push(i);
    }
    return bad;
  }

  return Object.freeze({
    DEFAULT_RADIUS: DEFAULT_RADIUS,
    haversine: haversine,
    buildZones: buildZones,
    isInsideAnyZone: function (p, zones, margin) { return validPt(p) && insideAny(p, buildZones(zones), margin || 0); },
    trimTrack: trimTrack,
    violations: violations
  });
})();
