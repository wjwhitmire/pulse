// PulseRoute: routable graph from Overpass API JSON, nearest-node snapping,
// A* with an optional heatmap preference, loop suggestions of a target
// distance, and GPX export. Pure functions: the app fetches Overpass JSON
// through its network gate and passes the parsed object (or text) in.
var PulseRoute = (function () {
  "use strict";

  var R = 6371008.8;
  var MAX_ELEMENTS = 1000000, MAX_TEXT = 64 * 1024 * 1024;
  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function rad(d) { return d * Math.PI / 180; }
  function hav(la1, lo1, la2, lo2) {
    var p1 = rad(la1), p2 = rad(la2), dp = p2 - p1, dl = rad(lo2 - lo1);
    var s1 = Math.sin(dp / 2), s2 = Math.sin(dl / 2);
    var h = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  function own(o, k) { return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k); }
  function tag(tags, k) { return own(tags, k) && typeof tags[k] === "string" ? tags[k] : null; }

  // Cost multipliers per highway type (1.0 = preferred). Absent = not routable.
  var PROFILES = {
    foot: {
      footway: 1.0, path: 1.0, pedestrian: 1.0, living_street: 1.0, track: 1.05, bridleway: 1.1, steps: 1.3,
      residential: 1.15, service: 1.2, unclassified: 1.2, road: 1.3, cycleway: 1.3,
      tertiary: 1.4, tertiary_link: 1.4, secondary: 1.7, secondary_link: 1.7, primary: 2.0, primary_link: 2.0
    },
    bike: {
      cycleway: 1.0, residential: 1.1, living_street: 1.2, unclassified: 1.15, service: 1.3, track: 1.4, path: 1.25, road: 1.3,
      tertiary: 1.3, tertiary_link: 1.3, secondary: 1.6, secondary_link: 1.6, primary: 2.0, primary_link: 2.0
    }
  };
  // Bike may use these only when explicitly allowed (bicycle=yes/designated/permissive).
  var BIKE_IF_ALLOWED = { footway: 1.5, pedestrian: 1.5, bridleway: 1.5 };
  var YES = { yes: 1, designated: 1, permissive: 1, official: 1 };
  var NO = { no: 1, private: 1, use_sidepath: 1 };
  var UNPAVED = { unpaved: 1, gravel: 1, fine_gravel: 1, dirt: 1, earth: 1, ground: 1, grass: 1, sand: 1, mud: 1, compacted: 1, pebblestone: 1, woodchips: 1 };

  function access(tags, profile) {
    var mode = profile === "bike" ? "bicycle" : "foot";
    var m = tag(tags, mode), a = tag(tags, "access");
    if (m && Object.prototype.hasOwnProperty.call(NO, m)) return false;
    if (m && Object.prototype.hasOwnProperty.call(YES, m)) return true;
    if (profile === "bike" && m === "dismount") return "dismount";
    if (a && (a === "no" || a === "private")) return false;
    return null; // default for the highway type
  }

  // Direction for this profile: 0 both ways, 1 forward only, -1 backward only.
  function oneway(tags, profile) {
    if (profile === "foot") {
      var f = tag(tags, "oneway:foot");
      return f === "yes" || f === "1" ? 1 : (f === "-1" ? -1 : 0);
    }
    var ob = tag(tags, "oneway:bicycle");
    if (ob === "no") return 0;
    var cw = tag(tags, "cycleway") || "";
    if (cw.indexOf("opposite") === 0) return 0;
    if (ob === "yes" || ob === "1") return 1;
    if (ob === "-1") return -1;
    var o = tag(tags, "oneway");
    if (o === "yes" || o === "true" || o === "1") return 1;
    if (o === "-1" || o === "reverse") return -1;
    if (o === "no") return 0;
    if (tag(tags, "junction") === "roundabout") return 1;
    return 0;
  }

  function wayFactor(tags, profile) {
    var hw = tag(tags, "highway");
    if (!hw) return null;
    if (tag(tags, "area") === "yes" && hw !== "pedestrian") return null;
    var table = PROFILES[profile];
    var base = Object.prototype.hasOwnProperty.call(table, hw) ? table[hw] : null;
    var acc = access(tags, profile);
    if (acc === false) return null;
    if (base === null) {
      if (profile === "bike" && acc === true && Object.prototype.hasOwnProperty.call(BIKE_IF_ALLOWED, hw)) base = BIKE_IF_ALLOWED[hw];
      else return null;
    }
    if (profile === "bike" && acc === "dismount") base = Math.max(base, 3.0);
    if (profile === "bike" && hw === "path" && acc === true) base = 1.0;
    var surf = tag(tags, "surface");
    var unpaved = (surf && Object.prototype.hasOwnProperty.call(UNPAVED, surf)) || (!surf && (hw === "track" || hw === "path" || hw === "bridleway"));
    if (profile === "bike" && unpaved) base *= 1.3;
    return { factor: base, unpaved: !!unpaved, highway: hw };
  }

  function parseInput(input) {
    var data = input;
    if (typeof input === "string") {
      if (input.length > MAX_TEXT) throw err("size", "Overpass response is too large.");
      try { data = JSON.parse(input, function (k, v) { return k === "__proto__" || k === "constructor" || k === "prototype" ? undefined : v; }); }
      catch (e) { throw err("json", "Overpass response is not valid JSON."); }
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.elements)) throw err("format", "Expected Overpass JSON with an elements array (use [out:json]).");
    if (data.elements.length > MAX_ELEMENTS) throw err("size", "Overpass response has too many elements.");
    return data.elements;
  }

  // Build a graph. opts.profile: "foot" (default) or "bike".
  function buildGraph(input, opts) {
    var profile = own(opts, "profile") && opts.profile === "bike" ? "bike" : "foot";
    var els = parseInput(input);
    var nodeLat = new Map(), nodeLon = new Map(), ways = [], warnings = [], i, j;
    for (i = 0; i < els.length; i++) {
      var e = els[i];
      if (!e || typeof e !== "object") continue;
      if (e.type === "node" && typeof e.id === "number" && typeof e.lat === "number" && typeof e.lon === "number" &&
          isFinite(e.lat) && isFinite(e.lon) && Math.abs(e.lat) <= 90 && Math.abs(e.lon) <= 180) {
        nodeLat.set(e.id, e.lat); nodeLon.set(e.id, e.lon);
      } else if (e.type === "way" && Array.isArray(e.nodes) && own(e, "tags") && typeof e.tags === "object") {
        var wf = wayFactor(e.tags, profile);
        if (wf) ways.push({ id: typeof e.id === "number" ? e.id : null, nodes: e.nodes, tags: e.tags, wf: wf });
      }
    }
    var index = new Map(), ids = [], lat = [], lon = [], adj = [];
    function idx(id) {
      var k = index.get(id);
      if (k === undefined) { k = ids.length; index.set(id, k); ids.push(id); lat.push(nodeLat.get(id)); lon.push(nodeLon.get(id)); adj.push([]); }
      return k;
    }
    var missing = 0, edges = 0;
    for (i = 0; i < ways.length; i++) {
      var w = ways[i], dir = oneway(w.tags, profile);
      if (w.nodes.length > 100000) { warnings.push("Skipped an oversized way."); continue; }
      for (j = 1; j < w.nodes.length; j++) {
        var a = w.nodes[j - 1], b = w.nodes[j];
        if (!nodeLat.has(a) || !nodeLat.has(b)) { missing++; continue; }
        if (a === b) continue;
        var ia = idx(a), ib = idx(b);
        var len = hav(lat[ia], lon[ia], lat[ib], lon[ib]);
        var base = { len: len, factor: w.wf.factor, unpaved: w.wf.unpaved, way: w.id, highway: w.wf.highway };
        if (dir >= 0) { adj[ia].push(edge(ib, base)); edges++; }
        if (dir <= 0) { adj[ib].push(edge(ia, base)); edges++; }
      }
    }
    if (missing) warnings.push(missing + " way link(s) refer to nodes missing from the response.");
    var minFactor = Infinity;
    for (i = 0; i < adj.length; i++) for (j = 0; j < adj[i].length; j++) minFactor = Math.min(minFactor, adj[i][j].factor);
    return { profile: profile, ids: ids, lat: lat, lon: lon, adj: adj, edges: edges, minFactor: isFinite(minFactor) ? minFactor : 1, warnings: warnings };
  }
  function edge(to, b) { return { to: to, len: b.len, factor: b.factor, unpaved: b.unpaved, way: b.way, highway: b.highway }; }

  // Nearest graph node to a point, within maxDist metres (default 300).
  function nearestNode(g, la, lo, maxDist) {
    if (typeof la !== "number" || typeof lo !== "number" || !isFinite(la) || !isFinite(lo)) throw err("input", "Point needs numeric lat and lon.");
    var lim = typeof maxDist === "number" && maxDist > 0 ? maxDist : 300;
    var best = -1, bd = Infinity;
    for (var i = 0; i < g.ids.length; i++) {
      // Cheap reject before the trig.
      if (Math.abs(g.lat[i] - la) * 111000 > Math.min(bd, lim)) continue;
      var d = hav(la, lo, g.lat[i], g.lon[i]);
      if (d < bd) { bd = d; best = i; }
    }
    return best >= 0 && bd <= lim ? { index: best, id: g.ids[best], distance: bd, lat: g.lat[best], lon: g.lon[best] } : null;
  }

  // Heat lookup: opts.heat is a function (lat, lon) -> 0..1, a Map, or a
  // plain object keyed "idA:idB" (OSM node ids, smaller first) -> 0..1.
  function heatFn(h) {
    if (!h) return null;
    if (typeof h === "function") return function (g, a, b) { return clamp01(h((g.lat[a] + g.lat[b]) / 2, (g.lon[a] + g.lon[b]) / 2)); };
    var isMap = Object.prototype.toString.call(h) === "[object Map]";
    return function (g, a, b) {
      var x = g.ids[a], y = g.ids[b], k = x < y ? x + ":" + y : y + ":" + x;
      return clamp01(isMap ? h.get(k) : (own(h, k) ? h[k] : 0));
    };
  }
  function clamp01(v) { return typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }

  // Binary min-heap of [priority, node].
  function Heap() { this.a = []; }
  Heap.prototype.push = function (p, n) {
    var a = this.a; a.push([p, n]); var i = a.length - 1;
    while (i > 0) { var j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; var t = a[i]; a[i] = a[j]; a[j] = t; i = j; }
  };
  Heap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        var t = a[i]; a[i] = a[m]; a[m] = t; i = m;
      }
    }
    return top;
  };

  // A* from node index s to t. opts: heat, heatWeight (0..0.8, default 0.4),
  // avoid (Set of "i>j" edge keys to penalize), avoidFactor (default 3),
  // maxExpand (default 2,000,000).
  // Edge cost = length x highway factor x (1 - heatWeight x heat) x avoid.
  function route(g, s, t, opts) {
    var n = g.ids.length;
    if (!(s >= 0 && s < n && t >= 0 && t < n)) throw err("input", "Route endpoints must be graph node indices.");
    var hw = own(opts, "heatWeight") && typeof opts.heatWeight === "number" ? Math.max(0, Math.min(0.8, opts.heatWeight)) : 0.4;
    var heat = heatFn(own(opts, "heat") ? opts.heat : null);
    if (!heat) hw = 0;
    var avoid = own(opts, "avoid") && opts.avoid && typeof opts.avoid.has === "function" ? opts.avoid : null;
    var avoidF = own(opts, "avoidFactor") && opts.avoidFactor >= 1 ? opts.avoidFactor : 3;
    var maxExpand = own(opts, "maxExpand") && opts.maxExpand > 0 ? opts.maxExpand : 2000000;
    // Admissible heuristic: straight-line distance x the cheapest possible factor.
    var hk = g.minFactor * (1 - hw);
    var gs = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    var heap = new Heap(), expanded = 0;
    gs[s] = 0; heap.push(hk * hav(g.lat[s], g.lon[s], g.lat[t], g.lon[t]), s);
    while (heap.a.length) {
      var u = heap.pop()[1];
      if (done[u]) continue;
      done[u] = 1;
      if (u === t) break;
      if (++expanded > maxExpand) throw err("limit", "Route search gave up: the area is too large.");
      var es = g.adj[u];
      for (var k = 0; k < es.length; k++) {
        var e = es[k], v = e.to;
        if (done[v]) continue;
        var c = e.len * e.factor;
        if (hw) c *= 1 - hw * heat(g, u, v);
        if (avoid && avoid.has(u + ">" + v)) c *= avoidF;
        var nv = gs[u] + c;
        if (nv < gs[v]) { gs[v] = nv; prev[v] = u; heap.push(nv + hk * hav(g.lat[v], g.lon[v], g.lat[t], g.lon[t]), v); }
      }
    }
    if (!isFinite(gs[t])) return null;
    var path = [];
    for (var x = t; x !== -1; x = prev[x]) path.push(x);
    path.reverse();
    return describe(g, path, gs[t], heat);
  }

  function edgeBetween(g, a, b) {
    var es = g.adj[a], best = null;
    for (var i = 0; i < es.length; i++) if (es[i].to === b && (!best || es[i].factor < best.factor)) best = es[i];
    return best;
  }

  function describe(g, path, cost, heat) {
    var dist = 0, unpaved = 0, heatSum = 0;
    for (var i = 1; i < path.length; i++) {
      var e = edgeBetween(g, path[i - 1], path[i]);
      dist += e.len;
      if (e.unpaved) unpaved += e.len;
      if (heat) heatSum += e.len * heat(g, path[i - 1], path[i]);
    }
    return {
      nodes: path,
      ids: path.map(function (i) { return g.ids[i]; }),
      coords: path.map(function (i) { return [g.lat[i], g.lon[i]]; }),
      distance: dist, cost: cost,
      unpavedShare: dist > 0 ? unpaved / dist : 0,
      heat: dist > 0 && heat ? heatSum / dist : 0
    };
  }

  // Route through several [lat, lon] waypoints, snapping each.
  function routeVia(g, points, opts) {
    if (!Array.isArray(points) || points.length < 2 || points.length > 100) throw err("input", "Give 2 to 100 waypoints.");
    var snaps = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (!Array.isArray(p)) throw err("input", "Waypoint " + (i + 1) + " must be [lat, lon].");
      var s = nearestNode(g, p[0], p[1], own(opts, "snapDistance") ? opts.snapDistance : 300);
      if (!s) return { error: "snap", waypoint: i };
      snaps.push(s.index);
    }
    var all = [snaps[0]], dist = 0, cost = 0;
    for (i = 1; i < snaps.length; i++) {
      var r = route(g, snaps[i - 1], snaps[i], opts);
      if (!r) return { error: "unreachable", waypoint: i };
      all = all.concat(r.nodes.slice(1)); dist += r.distance; cost += r.cost;
    }
    var out = describe(g, all, cost, heatFn(own(opts, "heat") ? opts.heat : null));
    return out;
  }

  // Destination point at distance d (m) on bearing brg (deg) from (la, lo).
  function offset(la, lo, d, brg) {
    var dr = d / R, b = rad(brg), p1 = rad(la), l1 = rad(lo);
    var p2 = Math.asin(Math.sin(p1) * Math.cos(dr) + Math.cos(p1) * Math.sin(dr) * Math.cos(b));
    var l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(p1), Math.cos(dr) - Math.sin(p1) * Math.sin(p2));
    return [p2 * 180 / Math.PI, l2 * 180 / Math.PI];
  }

  // Suggest loops of roughly targetMeters from node index start.
  // Each candidate is a triangle start -> A -> B -> start at one of `bearings`
  // headings; later legs are pushed off edges already used. Scored by length
  // error, reuse, unpaved share (bike) and heat popularity.
  function suggestLoops(g, start, targetMeters, opts) {
    if (!(start >= 0 && start < g.ids.length)) throw err("input", "Start must be a graph node index.");
    if (typeof targetMeters !== "number" || !(targetMeters >= 200 && targetMeters <= 300000)) throw err("input", "Target distance must be 200 m to 300 km.");
    var nb = own(opts, "bearings") ? Math.max(1, Math.min(36, Math.floor(opts.bearings))) : 8;
    var count = own(opts, "count") ? Math.max(1, Math.min(10, Math.floor(opts.count))) : 3;
    var tol = own(opts, "tolerance") ? opts.tolerance : 0.25;
    var detour = 1.25; // street networks run about 25 percent longer than straight lines
    var side = targetMeters / 3 / detour;
    var heat = own(opts, "heat") ? opts.heat : null;
    var la = g.lat[start], lo = g.lon[start], cands = [], seen = {};
    for (var k = 0; k < nb; k++) {
      var brg = k * 360 / nb;
      var A = offset(la, lo, side, brg), B = offset(la, lo, side, brg + 60);
      var sa = nearestNode(g, A[0], A[1], side), sb = nearestNode(g, B[0], B[1], side);
      if (!sa || !sb || sa.index === start || sb.index === start || sa.index === sb.index) continue;
      var used = new Set(), legs = [start, sa.index, sb.index, start], nodes = [start], ok = true, reused = 0;
      for (var l = 1; l < legs.length; l++) {
        var r = route(g, legs[l - 1], legs[l], { heat: heat, heatWeight: own(opts, "heatWeight") ? opts.heatWeight : 0.4, avoid: used, avoidFactor: 4 });
        if (!r) { ok = false; break; }
        for (var q = 1; q < r.nodes.length; q++) {
          var a = r.nodes[q - 1], b = r.nodes[q];
          if (used.has(a + ">" + b) || used.has(b + ">" + a)) reused += edgeBetween(g, a, b).len;
        }
        for (q = 1; q < r.nodes.length; q++) { used.add(r.nodes[q - 1] + ">" + r.nodes[q]); used.add(r.nodes[q] + ">" + r.nodes[q - 1]); }
        nodes = nodes.concat(r.nodes.slice(1));
      }
      if (!ok) continue;
      var d = describe(g, nodes, 0, heatFn(heat));
      var key = d.ids.join(",");
      if (Object.prototype.hasOwnProperty.call(seen, key)) continue;
      seen[key] = 1;
      var lenErr = Math.abs(d.distance - targetMeters) / targetMeters;
      var overlap = d.distance > 0 ? reused / d.distance : 1;
      d.bearing = brg;
      d.overlap = overlap;
      d.lengthError = lenErr;
      d.score = 2 * lenErr + overlap + (g.profile === "bike" ? 0.3 * d.unpavedShare : 0) - 0.3 * d.heat;
      if (lenErr <= tol) cands.push(d);
    }
    cands.sort(function (x, y) { return x.score - y.score; });
    return cands.slice(0, count);
  }

  // ------------------------------------------------------------------ GPX
  function xmlEscape(s) {
    return String(s)
      .replace(/[^\u0009\u000A\u000D -퟿-�]/g, "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
  function coord(v, lim) {
    if (typeof v !== "number" || !isFinite(v) || Math.abs(v) > lim) throw err("input", "GPX coordinate out of range.");
    return v.toFixed(7);
  }
  // coords: [[lat, lon]] or [[lat, lon, ele]] or [{lat, lon, ele}]. opts.name, opts.time (ISO string for metadata).
  function toGpx(coords, opts) {
    if (!Array.isArray(coords) || coords.length > 1000000) throw err("input", "GPX needs an array of points.");
    var name = own(opts, "name") ? String(opts.name).slice(0, 200) : "Pulse route";
    var lines = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Pulse" xmlns="http://www.topografix.com/GPX/1/1">',
      "  <metadata><name>" + xmlEscape(name) + "</name>" + (own(opts, "time") && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(String(opts.time)) ? "<time>" + opts.time + "</time>" : "") + "</metadata>",
      "  <trk><name>" + xmlEscape(name) + "</name><trkseg>"];
    for (var i = 0; i < coords.length; i++) {
      var p = coords[i], la, lo, el;
      if (Array.isArray(p)) { la = p[0]; lo = p[1]; el = p[2]; } else if (p && typeof p === "object") { la = p.lat; lo = p.lon; el = p.ele; }
      var s = '    <trkpt lat="' + coord(la, 90) + '" lon="' + coord(lo, 180) + '"';
      s += typeof el === "number" && isFinite(el) ? "><ele>" + el.toFixed(1) + "</ele></trkpt>" : "/>";
      lines.push(s);
    }
    lines.push("  </trkseg></trk>", "</gpx>", "");
    return lines.join("\n");
  }

  // Overpass QL for the walkable or rideable ways in a bounding box. The app
  // sends this through its gate; the library never fetches.
  function overpassQuery(south, west, north, east, profile) {
    var b = [south, west, north, east];
    for (var i = 0; i < 4; i++) if (typeof b[i] !== "number" || !isFinite(b[i])) throw err("input", "Bounding box must be numbers.");
    if (!(south < north && west < east) || Math.abs(south) > 90 || Math.abs(north) > 90 || Math.abs(west) > 180 || Math.abs(east) > 180) throw err("input", "Bounding box is invalid.");
    if ((north - south) * (east - west) > 0.25) throw err("input", "Area is too large for one request.");
    var types = Object.keys(profile === "bike" ? Object.assign({}, PROFILES.bike, BIKE_IF_ALLOWED) : PROFILES.foot).join("|");
    var bbox = b.map(function (v) { return v.toFixed(6); }).join(",");
    return "[out:json][timeout:25];way[\"highway\"~\"^(" + types + ")$\"](" + bbox + ");(._;>;);out body;";
  }

  return Object.freeze({
    PROFILES: PROFILES,
    buildGraph: buildGraph,
    nearestNode: nearestNode,
    route: route,
    routeVia: routeVia,
    suggestLoops: suggestLoops,
    toGpx: toGpx,
    overpassQuery: overpassQuery,
    distance: hav
  });
})();
