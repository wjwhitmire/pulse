import { test, load, near, throwsCode, assert, rng } from "./harness.mjs";
const S = load("segments.js", "PulseSegments");

const LAT0 = 45, LON0 = 7, K = 6371008.8 * Math.PI / 180;
const ll = (x, y) => ({ lat: LAT0 + y / K, lon: LON0 + x / (K * Math.cos(LAT0 * Math.PI / 180)) });
// Walk a polyline of [x,y] metres at speed v (m/s), one point per dt seconds.
function walk(path, v, dt = 1, t0 = 0, noise = 0, seed = 1) {
  const rand = rng(seed), out = [];
  let t = t0, carry = 0;
  out.push({ ...ll(path[0][0], path[0][1]), t });
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1], [bx, by] = path[i];
    const L = Math.hypot(bx - ax, by - ay);
    let pos = v * dt - carry;
    while (pos <= L) {
      t += dt;
      const f = pos / L;
      out.push({ ...ll(ax + (bx - ax) * f + (rand() - 0.5) * 2 * noise, ay + (by - ay) * f + (rand() - 0.5) * 2 * noise), t });
      pos += v * dt;
    }
    carry = L - (pos - v * dt);
  }
  return out;
}
// L-shaped segment: 500 m east then 500 m north.
const SEG_PATH = [[0, 0], [500, 0], [500, 500]];
const segTrack = walk(SEG_PATH, 5, 2);
const seg = S.defineSegment(segTrack);

test("defineSegment builds gates, corridor and resampled line", () => {
  near(seg.length, 1000, 6);
  near(seg.start.dir[0], 1, 1e-6); near(seg.start.dir[1], 0, 1e-6);
  near(seg.end.dir[0], 0, 1e-6); near(seg.end.dir[1], 1, 1e-6);
  assert.equal(seg.gateHalfWidth, 25); assert.equal(seg.corridor, 30);
  assert.ok(seg.line.length >= 95 && seg.line.length <= 105);
  // Serializable: survives a JSON round trip unchanged in meaning.
  const again = JSON.parse(JSON.stringify(seg));
  assert.equal(S.matchEfforts(again, walk([[-100, 0], ...SEG_PATH, [500, 600]], 4)).efforts.length, 1);
});

test("effort elapsed time is interpolated at both gates", () => {
  // Start 103 m before the start gate, 4 m/s, 1 s points: gate falls between points.
  const tr = walk([[-103, 0], ...SEG_PATH, [500, 597]], 4, 1, 1000);
  const r = S.matchEfforts(seg, tr);
  assert.equal(r.efforts.length, 1);
  const e = r.efforts[0];
  near(e.startTime, 1000 + 103 / 4, 1e-6);
  near(e.elapsed, 1000 / 4, 1e-6);
  near(e.distance, 1000, 1.5);
});

test("noisy GPS still matches", () => {
  const tr = walk([[-60, 0], ...SEG_PATH, [500, 560]], 3.3, 1, 0, 6, 3);
  const r = S.matchEfforts(seg, tr);
  assert.equal(r.efforts.length, 1, JSON.stringify(r.rejected));
  near(r.efforts[0].elapsed, 1000 / 3.3, 3);
});

test("cutting the corner is rejected as a shortcut", () => {
  const tr = walk([[-60, 0], [250, 0], [500, 250], [500, 560]], 4);
  const r = S.matchEfforts(seg, tr);
  assert.equal(r.efforts.length, 0);
  assert.ok(r.rejected.some((x) => x.reason === "left-corridor" || x.reason === "shortcut"));
});

test("shortcut that stays inside a wide corridor is still rejected by ordered checkpoints", () => {
  // Narrow U-shaped segment: out 400 m, across 40 m, back 400 m.
  const U = [[0, 0], [400, 0], [400, 40], [0, 40]];
  const useg = S.defineSegment(walk(U, 5, 1), 0, undefined, { corridor: 30, gateHalfWidth: 15 });
  // Athlete crosses the start gate then cuts straight across to the end gate.
  const tr = walk([[-30, 0], [10, 0], [10, 40], [-30, 40]], 4);
  const r = S.matchEfforts(useg, tr);
  assert.equal(r.efforts.length, 0);
  assert.equal(r.rejected[0].reason, "shortcut");
  // The honest effort matches.
  assert.equal(S.matchEfforts(useg, walk([[-30, 0], ...U, [-30, 40]], 4)).efforts.length, 1);
});

test("wrong direction does not match", () => {
  const tr = walk([[500, 600], [500, 0], [0, 0], [-100, 0]], 4);
  assert.equal(S.matchEfforts(seg, tr).efforts.length, 0);
});

test("passing beside the start gate does not count", () => {
  const tr = walk([[-60, 60], [500, 60], [500, 560]], 4); // 60 m north of the start gate
  assert.equal(S.matchEfforts(seg, tr).efforts.length, 0);
});

test("excursion out of the corridor rejects the effort", () => {
  const tr = walk([[-60, 0], [200, 0], [250, -80], [300, 0], [500, 0], [500, 560]], 4);
  const r = S.matchEfforts(seg, tr);
  assert.equal(r.efforts.length, 0);
  assert.equal(r.rejected[0].reason, "left-corridor");
});

test("two laps give two efforts and bestEffort picks the faster", () => {
  const lap1 = walk([[-60, 0], ...SEG_PATH, [500, 560]], 4, 1, 0);
  const t1 = lap1[lap1.length - 1].t;
  const back = walk([[500, 560], [-60, 560], [-60, 0]], 6, 1, t1);
  const lap2 = walk([[-60, 0], ...SEG_PATH, [500, 560]], 5, 1, back[back.length - 1].t);
  const tr = [...lap1, ...back.slice(1), ...lap2.slice(1)];
  const r = S.matchEfforts(seg, tr);
  assert.equal(r.efforts.length, 2);
  near(S.bestEffort(seg, tr).elapsed, 200, 1e-6);
});

test("loop segment with start gate equal to end gate", () => {
  const sq = [[0, 0], [300, 0], [300, 300], [0, 300], [0, 0], [30, 0]];
  const loopSeg = S.defineSegment(walk(sq.slice(0, 5), 5, 1));
  const tr = walk([[-50, 0], ...sq.slice(0, 5), [60, 0]], 4, 1, 0);
  const r = S.matchEfforts(loopSeg, tr);
  assert.equal(r.efforts.length, 1, JSON.stringify(r.rejected));
  near(r.efforts[0].elapsed, 1200 / 4, 0.5);
});

test("garbage input", () => {
  throwsCode(() => S.defineSegment("x"), "input");
  throwsCode(() => S.defineSegment([ll(0, 0)]), "range");
  throwsCode(() => S.defineSegment(walk([[0, 0], [20, 0]], 5)), "short");
  throwsCode(() => S.matchEfforts({ line: [[1, 2]] }, segTrack), "segment");
  throwsCode(() => S.matchEfforts({ ...seg, start: { lat: 45, lon: 7, dir: [0, 0] } }, segTrack), "segment");
  throwsCode(() => S.matchEfforts({ ...seg, line: [[45, 7], ["a", 7]] }, segTrack), "segment");
  const r = S.matchEfforts(seg, [null, {}, { lat: NaN, lon: 1, t: 1 }, { lat: 45, lon: 7, t: "x" }]);
  assert.equal(r.efforts.length, 0);
  throwsCode(() => S.matchEfforts(seg, { length: 5 }), "input");
});

test("time going backwards is dropped, not trusted", () => {
  const tr = walk([[-60, 0], ...SEG_PATH, [500, 560]], 4);
  tr.splice(50, 0, { ...tr[50], t: -1e9 });
  const r = S.matchEfforts(seg, tr);
  assert.equal(r.efforts.length, 1);
  near(r.efforts[0].elapsed, 250, 1e-6);
});
