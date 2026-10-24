import { test, load, throwsCode, assert, rng, same } from "./harness.mjs";
const P = load("privacy.js", "PulsePrivacy");

const LAT0 = 45, LON0 = 7, K = 6371008.8 * Math.PI / 180;
const ll = (x, y) => ({ lat: LAT0 + y / K, lon: LON0 + x / (K * Math.cos(LAT0 * Math.PI / 180)) });
function line(path, step) {
  const out = [];
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1], [bx, by] = path[i], L = Math.hypot(bx - ax, by - ay);
    for (let d = 0; d < L; d += step) out.push(ll(ax + (bx - ax) * d / L, ay + (by - ay) * d / L));
  }
  out.push(ll(...path[path.length - 1]));
  return out.map((p, i) => ({ ...p, t: i }));
}

function assertClean(points, zones, start, end, trim) {
  for (const p of points) {
    for (const z of zones) assert.ok(P.haversine(p, z) > z.radius, "point inside zone survived");
    assert.ok(P.haversine(p, start) > trim, "point near start survived");
    assert.ok(P.haversine(p, end) > trim, "point near end survived");
  }
}

test("start and end are trimmed along track and by distance", () => {
  const tr = line([[0, 0], [2000, 0]], 5);
  const r = P.trimTrack(tr, {});
  assertClean(r.points, [], tr[0], tr[tr.length - 1], 200);
  assert.ok(r.points.length > 250 && r.points.length < 320);
  assert.equal(r.runs.length, 1);
});

test("out-and-back past home: no point near home survives", () => {
  // Starts at home, runs 1 km out, comes back past home, ends 500 m beyond.
  const home = ll(0, 0);
  const tr = line([[0, 0], [1000, 0], [0, 10], [-1500, 10]], 4);
  const zones = [{ ...home, radius: 300 }];
  const r = P.trimTrack(tr, { zones });
  assertClean(r.points, zones, tr[0], tr[tr.length - 1], 200);
  assert.ok(r.runs.length >= 2, "gap where the track passes home");
  same(P.violations(r.points, zones), []);
});

test("randomized: no surviving point is inside any zone", () => {
  const rand = rng(42);
  for (let trial = 0; trial < 50; trial++) {
    const path = [[0, 0]];
    for (let k = 0; k < 8; k++) path.push([path[k][0] + (rand() - 0.5) * 3000, path[k][1] + (rand() - 0.5) * 3000]);
    const tr = line(path, 3 + rand() * 20);
    const zones = [];
    for (let z = 0; z < 4; z++) zones.push({ ...ll((rand() - 0.5) * 4000, (rand() - 0.5) * 4000), radius: 50 + rand() * 400 });
    const trim = rand() * 500;
    const r = P.trimTrack(tr, { zones, trimStart: trim, trimEnd: trim });
    assertClean(r.points, zones, tr[0], tr[tr.length - 1], trim);
    assert.equal(P.violations(r.points, zones).length, 0);
  }
});

test("default zone radius is 200 m and zone radii are respected", () => {
  const z = P.buildZones([{ lat: 45, lon: 7 }, { lat: 46, lon: 7, radius: 50 }]);
  assert.equal(z[0].radius, 200); assert.equal(z[1].radius, 50);
  assert.equal(P.isInsideAnyZone(ll(0, 150), [{ lat: 45, lon: 7 }]), true);
  assert.equal(P.isInsideAnyZone(ll(0, 250), [{ lat: 45, lon: 7 }]), false);
});

test("only known numeric fields are copied out", () => {
  const tr = line([[0, 0], [1500, 0]], 10).map((p) => ({ ...p, name: "home address", hr: 140, ele: 12, extra: { a: 1 } }));
  const r = P.trimTrack(tr, {});
  for (const p of r.points) same(Object.keys(p).sort(), ["ele", "hr", "lat", "lon", "t"]);
});

test("invalid points are dropped; bad zones throw rather than leak", () => {
  const tr = [...line([[0, 0], [1500, 0]], 10), null, { lat: "45", lon: 7 }, { lat: 91, lon: 0 }];
  const r = P.trimTrack(tr, { trimStart: 0, trimEnd: 0 });
  assert.equal(r.removed, 3);
  throwsCode(() => P.trimTrack(tr, { zones: [{ lat: "x", lon: 1 }] }), "zone");
  throwsCode(() => P.trimTrack(tr, { zones: [{ lat: 45, lon: 7, radius: -1 }] }), "zone");
  throwsCode(() => P.trimTrack(tr, { zones: [{ lat: 45, lon: 7, radius: NaN }] }), "zone");
  throwsCode(() => P.trimTrack(tr, { trimStart: -5 }), "input");
  throwsCode(() => P.trimTrack(tr, { trimStart: "200" }), "input");
  throwsCode(() => P.trimTrack("track"), "input");
  throwsCode(() => P.buildZones(new Array(5000).fill({ lat: 1, lon: 1 })), "size");
});

test("prototype pollution keys in options are inert", () => {
  const opts = JSON.parse('{"__proto__": {"trimStart": 0}, "zones": []}');
  const tr = line([[0, 0], [1500, 0]], 10);
  const r = P.trimTrack(tr, opts);
  assertClean(r.points, [], tr[0], tr[tr.length - 1], 200);
  assert.equal({}.trimStart, undefined);
});

test("tiny track inside a zone vanishes entirely", () => {
  const tr = line([[0, 0], [150, 0]], 5);
  const r = P.trimTrack(tr, {});
  assert.equal(r.points.length, 0); assert.equal(r.runs.length, 0);
  same(P.trimTrack([], {}).points, []);
});
