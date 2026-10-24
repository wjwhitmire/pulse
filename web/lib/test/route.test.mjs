import { test, load, fixture, near, throwsCode, assert, rng, same } from "./harness.mjs";
const R = load("route.js", "PulseRoute");
const FX = fixture("overpass_small.json");
const foot = R.buildGraph(FX, { profile: "foot" });
const bike = R.buildGraph(JSON.parse(FX), { profile: "bike" });
const ix = (g, id) => g.ids.indexOf(id);
const hasEdge = (g, a, b) => g.adj[ix(g, a)] && g.adj[ix(g, a)].some((e) => g.ids[e.to] === b);

test("foot graph excludes motorway, private and foot=no ways", () => {
  assert.equal(ix(foot, 141), -1, "motorway-only node");
  assert.ok(!hasEdge(foot, 102, 112), "private service");
  assert.ok(!hasEdge(foot, 111, 123), "foot=no");
  assert.ok(hasEdge(foot, 121, 131), "steps are walkable");
  assert.ok(hasEdge(foot, 134, 144) && hasEdge(foot, 144, 134), "footway with hostile tag keys still parses");
  assert.ok(foot.warnings.some((w) => /missing/.test(w)));
  assert.equal({}.polluted, undefined);
});

test("bike graph: no footways, steps or bicycle=no; designated footway allowed", () => {
  assert.ok(!hasEdge(bike, 120, 121), "plain footway");
  assert.ok(!hasEdge(bike, 121, 131), "steps");
  assert.ok(!hasEdge(bike, 110, 111), "bicycle=no path");
  assert.ok(hasEdge(bike, 111, 123) && hasEdge(bike, 123, 111), "bicycle=designated footway");
  assert.ok(hasEdge(bike, 122, 132), "cycleway");
});

test("oneway rules for bikes, ignored on foot", () => {
  assert.ok(hasEdge(bike, 104, 114) && !hasEdge(bike, 114, 104), "oneway=yes");
  assert.ok(hasEdge(bike, 113, 103) && !hasEdge(bike, 103, 113), "oneway=-1");
  assert.ok(hasEdge(bike, 101, 111) && hasEdge(bike, 111, 101), "oneway:bicycle=no");
  assert.ok(hasEdge(foot, 114, 104) && hasEdge(foot, 103, 113), "pedestrians walk both ways");
});

test("A* respects oneway and access", () => {
  const f = R.route(foot, ix(foot, 144), ix(foot, 104));
  near(f.distance, 400, 2);
  assert.equal(R.route(bike, ix(bike, 144), ix(bike, 104)), null, "144 is a dead end for bikes: oneway north, motorway, footway");
  const b = R.route(bike, ix(bike, 134), ix(bike, 104));
  near(b.distance, 1100, 3, "bike detours west around the oneway");
  for (let i = 1; i < b.ids.length; i++) assert.ok(!(b.ids[i - 1] === 114 && b.ids[i] === 104));
  const p = R.route(foot, ix(foot, 102), ix(foot, 122));
  assert.ok(p.distance > 350, "private road avoided");
});

test("A* matches Dijkstra on random grids", () => {
  const rand = rng(5);
  for (let trial = 0; trial < 10; trial++) {
    const els = [], N = 12, kinds = ["footway", "residential", "tertiary", "primary", "path", "motorway"];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) els.push({ type: "node", id: r * N + c + 1, lat: 45 + r * 0.0009 + (rand() - 0.5) * 3e-4, lon: 7 + c * 0.00127 + (rand() - 0.5) * 3e-4 });
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const id = r * N + c + 1;
      if (c + 1 < N && rand() < 0.8) els.push({ type: "way", id: els.length, nodes: [id, id + 1], tags: { highway: kinds[Math.floor(rand() * kinds.length)] } });
      if (r + 1 < N && rand() < 0.8) els.push({ type: "way", id: els.length, nodes: [id, id + N], tags: { highway: kinds[Math.floor(rand() * kinds.length)] } });
    }
    const g = R.buildGraph({ elements: els });
    const s = Math.floor(rand() * g.ids.length), t = Math.floor(rand() * g.ids.length);
    // Plain Dijkstra on the same graph.
    const dist = new Array(g.ids.length).fill(Infinity), done = new Array(g.ids.length).fill(false);
    dist[s] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < dist.length; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || dist[u] === Infinity) break;
      done[u] = true;
      for (const e of g.adj[u]) if (dist[u] + e.len * e.factor < dist[e.to]) dist[e.to] = dist[u] + e.len * e.factor;
    }
    const r = R.route(g, s, t);
    if (dist[t] === Infinity) assert.equal(r, null);
    else near(r.cost, dist[t], 1e-6, "trial " + trial);
  }
});

test("heatmap preference changes the route between equal options", () => {
  // From 100 to 122 on foot: equal-ish options west (col 0 then row 2) or via steps.
  const s = ix(foot, 120), t = ix(foot, 124);
  const plain = R.route(foot, s, t);
  same(plain.ids, [120, 121, 122, 123, 124]);
  // Make the row-3 detour popular: 120 -> 130 -> ... -> 134 -> 124? 134-124 has no link, so use col 4.
  const heat = { "120:130": 1, "130:131": 1, "131:132": 1, "132:133": 1, "133:134": 1, "134:144": 1, "124:134": 1 };
  const hot = R.route(foot, s, t, { heat, heatWeight: 0.8 });
  assert.ok(hot.heat > plain.heat);
  const fn = R.route(foot, s, t, { heat: () => 0.5 });
  same(fn.ids, plain.ids);
  // Hostile heat values are clamped.
  const junk = R.route(foot, s, t, { heat: { "120:121": -50, "121:122": "x", "122:123": Infinity } });
  same(junk.ids, plain.ids);
});

test("snapping and unreachable targets", () => {
  const s = R.nearestNode(foot, 45.00002, 7.00002);
  assert.equal(s.id, 100); assert.ok(s.distance < 5);
  assert.equal(R.nearestNode(foot, 46, 8), null);
  assert.equal(R.route(foot, ix(foot, 100), ix(foot, 200)), null);
  throwsCode(() => R.nearestNode(foot, "45", 7), "input");
  throwsCode(() => R.route(foot, -1, 3), "input");
});

test("routeVia stitches legs", () => {
  const r = R.routeVia(foot, [[45, 7], [45.0018, 7.0050872], [45, 7.0050872]]);
  assert.equal(r.ids[0], 100); assert.equal(r.ids[r.ids.length - 1], 104);
  assert.equal(R.routeVia(foot, [[45, 7], [45.0101, 7.0101]]).error, "unreachable");
  assert.equal(R.routeVia(foot, [[45, 7], [10, 10]]).error, "snap");
  throwsCode(() => R.routeVia(foot, [[45, 7]]), "input");
});

test("loop suggestions land near the target distance", () => {
  const loops = R.suggestLoops(foot, ix(foot, 100), 800, { count: 3 });
  assert.ok(loops.length >= 1);
  for (const l of loops) {
    assert.equal(l.ids[0], 100); assert.equal(l.ids[l.ids.length - 1], 100);
    assert.ok(Math.abs(l.distance - 800) / 800 <= 0.25, "loop " + l.distance);
  }
  for (let i = 1; i < loops.length; i++) assert.ok(loops[i].score >= loops[i - 1].score);
  throwsCode(() => R.suggestLoops(foot, 0, 50), "input");
});

test("GPX export is escaped and well formed", () => {
  const gpx = R.toGpx([[45, 7, 120.25], { lat: 45.001, lon: 7.001 }], { name: 'Loop <b>&"x"\u0001', time: "2026-10-21T07:00:00Z" });
  assert.ok(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(gpx.includes('xmlns="http://www.topografix.com/GPX/1/1"'));
  assert.ok(gpx.includes("<name>Loop &lt;b&gt;&amp;&quot;x&quot;</name>"));
  assert.ok(gpx.includes('<trkpt lat="45.0000000" lon="7.0000000"><ele>120.3</ele></trkpt>') || gpx.includes("<ele>120.2</ele>"));
  assert.ok(gpx.includes('<trkpt lat="45.0010000" lon="7.0010000"/>'));
  assert.ok(gpx.includes("<time>2026-10-21T07:00:00Z</time>"));
  assert.ok(!R.toGpx([], { time: "<script>" }).includes("script"));
  throwsCode(() => R.toGpx([[95, 7]]), "input");
  throwsCode(() => R.toGpx([["45", 7]]), "input");
});

test("hostile Overpass input", () => {
  throwsCode(() => R.buildGraph("not json"), "json");
  throwsCode(() => R.buildGraph("{}"), "format");
  throwsCode(() => R.buildGraph({ elements: "x" }), "format");
  throwsCode(() => R.buildGraph({ elements: new Array(1000001) }), "size");
  const g = R.buildGraph('{"__proto__":{"elements":[]},"elements":[null,1,"x",{"type":"node","id":1,"lat":"45","lon":7},{"type":"way","nodes":[1,2],"tags":null},{"type":"way","nodes":"12","tags":{"highway":"footway"}},{"type":"node","id":2,"lat":999,"lon":0}]}');
  assert.equal(g.ids.length, 0);
  assert.equal({}.elements, undefined);
});

test("Overpass query builder", () => {
  const q = R.overpassQuery(45, 7, 45.01, 7.01, "foot");
  assert.ok(q.startsWith("[out:json]"));
  assert.ok(q.includes("(45.000000,7.000000,45.010000,7.010000)"));
  assert.ok(q.includes("footway") && !q.includes("motorway"));
  throwsCode(() => R.overpassQuery(45, 7, 46, 8), "input");
  throwsCode(() => R.overpassQuery(45, 7, 44, 8), "input");
  throwsCode(() => R.overpassQuery("45);out;", 7, 45.1, 7.1), "input");
});
