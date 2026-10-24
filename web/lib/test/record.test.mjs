import { test, load, near, throwsCode, assert, rng } from "./harness.mjs";
const P = load("record.js", "PulseRecord");

const LAT0 = 45.0, LON0 = 7.0, M_PER_DEG_LAT = 111195.08;
const mLon = M_PER_DEG_LAT * Math.cos(LAT0 * Math.PI / 180);
// Build fixes from a speed profile: segments of [seconds, m/s]. 1 Hz fixes heading east.
function track(profile, opts = {}) {
  const rand = rng(opts.seed || 1), noise = opts.noise || 0;
  const out = []; let x = 0, t = 0;
  for (const [secs, v] of profile) {
    for (let i = 0; i < secs; i++) {
      t += 1000; x += v;
      out.push({ t: 1.7e12 + t, lat: LAT0 + (rand() - 0.5) * 2 * noise / M_PER_DEG_LAT, lon: LON0 + (x + (rand() - 0.5) * 2 * noise) / mLon, acc: 5 });
    }
  }
  return out;
}

test("haversine: one degree of latitude", () => {
  near(P.haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 6371008.8 * Math.PI / 180, 1e-6);
  near(P.haversine({ lat: 10, lon: 10 }, { lat: 10, lon: 10 }), 0, 1e-9);
});

test("steady run: distance, moving time and splits", () => {
  const s = P.processTrack(track([[600, 3.0]]));
  near(s.distance, 1797, 6);            // 599 intervals at 3 m/s
  near(s.movingTime, 599000, 1);
  assert.equal(s.splitList.length, 1);
  near(s.splitList[0].time / 1000, 333.3, 2.5);
  near(s.pace, 333.3, 3);               // s/km
  near(s.avgPace, 333.3, 3);
  assert.equal(s.paused, false);
});

test("GPS jitter while standing does not add distance", () => {
  const s = P.processTrack(track([[300, 0]], { noise: 3, seed: 4 }));
  assert.ok(s.distance < 30, "jitter distance " + s.distance);
  assert.equal(s.paused, true);
});

test("noisy run stays within 3 percent of true distance", () => {
  const s = P.processTrack(track([[900, 3.5]], { noise: 2.5, seed: 9 }));
  const truth = 899 * 3.5;
  assert.ok(Math.abs(s.distance - truth) / truth < 0.03, "got " + s.distance + " vs " + truth);
});

test("auto-pause at a stop, resume after, with hysteresis", () => {
  const s = P.processTrack(track([[120, 3], [120, 0], [120, 3]]));
  near(s.distance, 2 * 120 * 3, 15);
  // Moving time excludes the stop (120 s), within the dwell tolerances.
  near(s.movingTime / 1000, 240, 8);
  assert.equal(s.paused, false);
  // Hover around the pause speed: 0.9 m/s sits inside the band, so it never pauses then never resumes.
  const band = P.processTrack(track([[60, 3], [60, 0.9]]));
  assert.equal(band.paused, false, "0.9 m/s is above pauseSpeed, stays moving");
  const band2 = P.processTrack(track([[60, 3], [60, 0], [60, 0.9]]));
  assert.equal(band2.paused, true, "0.9 m/s is below resumeSpeed, stays paused");
});

test("autoPause off counts everything", () => {
  const s = P.processTrack(track([[60, 3], [60, 0]]), { autoPause: false });
  near(s.movingTime / 1000, 119, 1);
});

test("manual pause stops distance and time", () => {
  const st = P.createRecorder();
  const fx = track([[60, 3], [60, 3], [60, 3]]);
  for (let i = 0; i < 60; i++) P.addFix(st, fx[i]);
  P.setManualPause(st, true);
  for (let i = 60; i < 120; i++) P.addFix(st, fx[i]);
  P.setManualPause(st, false);
  for (let i = 120; i < 180; i++) P.addFix(st, fx[i]);
  const s = P.summary(st);
  near(s.distance, 179 * 3 - 60 * 3, 12);
  near(s.movingTime / 1000, 119, 3);
});

test("accuracy filter and invalid fixes", () => {
  const st = P.createRecorder({ maxAccuracy: 20 });
  assert.equal(P.addFix(st, { t: 1, lat: 45, lon: 7, acc: 50 }).reason, "accuracy");
  assert.equal(P.addFix(st, { t: 1, lat: 95, lon: 7 }).reason, "invalid");
  assert.equal(P.addFix(st, { t: 1, lat: NaN, lon: 7 }).reason, "invalid");
  assert.equal(P.addFix(st, null).reason, "invalid");
  assert.equal(P.addFix(st, { t: "1", lat: 45, lon: 7 }).reason, "invalid");
  assert.equal(P.addFix(st, { t: 1000, lat: 45, lon: 7, acc: 5 }).accepted, true);
  assert.equal(P.addFix(st, { t: 1000, lat: 45, lon: 7, acc: 5 }).reason, "time");
  assert.equal(P.addFix(st, { t: 500, lat: 45, lon: 7, acc: 5 }).reason, "time");
});

test("single speed spike is rejected and adds no distance", () => {
  const fx = track([[200, 3]]);
  fx[100] = { ...fx[100], lat: fx[100].lat + 0.01 }; // ~1.1 km jump north for one fix
  const s = P.processTrack(fx);
  assert.equal(s.rejected.spike, 1);
  near(s.distance, 199 * 3, 8);
});

test("bad first fix re-anchors after consistent fixes", () => {
  const fx = track([[200, 3]]);
  fx.unshift({ t: fx[0].t - 1000, lat: LAT0 + 0.05, lon: LON0, acc: 5 }); // 5.5 km away
  const s = P.processTrack(fx);
  assert.ok(s.rejected.spike <= 4, "spikes " + s.rejected.spike);
  near(s.distance, 199 * 3, 25);
});

test("laps close with their own distance and time", () => {
  const st = P.createRecorder();
  const fx = track([[100, 3], [100, 4]]);
  for (let i = 0; i < 100; i++) P.addFix(st, fx[i]);
  const l1 = P.lap(st);
  for (let i = 100; i < 200; i++) P.addFix(st, fx[i]);
  const l2 = P.lap(st);
  near(l1.distance, 297, 8); near(l2.distance, 400, 8);
  near(l1.movingTime / 1000, 99, 1); near(l2.movingTime / 1000, 100, 1);
  near(l2.pace, 250, 6);
  assert.equal(st.laps.length, 2);
});

test("current pace follows a speed change", () => {
  const s = P.processTrack(track([[600, 2.5], [300, 5]]));
  near(s.pace, 200, 4); // last 400 m at 5 m/s
});

test("split times interpolate to the boundary", () => {
  const s = P.processTrack(track([[1000, 4]]), { splitDistance: 500 });
  assert.equal(s.splitList.length, 7);
  for (const sp of s.splitList.slice(1)) near(sp.time / 1000, 125, 1.5);
});

test("huge input is bounded by decimation", () => {
  const fx = track([[5000, 3]]);
  const s = P.processTrack(fx, { maxPoints: 1000 });
  assert.ok(s.track.length <= 1000);
  near(s.distance, 4999 * 3, 40);
  throwsCode(() => P.processTrack("nope"), "input");
});

test("hostile options fall back to defaults", () => {
  const opts = JSON.parse('{"__proto__": {"polluted": 1}, "maxSpeed": "fast", "smoothN": -5, "sport": "constructor"}');
  const s = P.processTrack(track([[100, 3]]), opts);
  near(s.distance, 297, 8);
  assert.equal({}.polluted, undefined);
});
