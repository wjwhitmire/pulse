import { test, load, same, near, throwsCode, assert, rng } from "./harness.mjs";
const H = load("blehr.js", "PulseBLEHR");

test("uint8 HR, no extras", () => {
  const r = H.decodeHeartRate([0x00, 72]);
  assert.equal(r.hr, 72); assert.equal(r.format, "uint8");
  assert.equal(r.contact, "unsupported"); assert.equal(r.contactDetected, null);
  assert.equal(r.energyKJ, null); same(r.rrRaw, []); same(r.warnings, []);
});

test("uint16 HR little endian", () => {
  const r = H.decodeHeartRate([0x01, 0x2C, 0x01]); // 300
  assert.equal(r.hr, 300); assert.equal(r.format, "uint16");
});

test("sensor contact states", () => {
  assert.equal(H.decodeHeartRate([0x02, 60]).contact, "unsupported");
  const nc = H.decodeHeartRate([0x04, 60]);
  assert.equal(nc.contact, "no-contact"); assert.equal(nc.contactSupported, true); assert.equal(nc.contactDetected, false);
  const c = H.decodeHeartRate([0x06, 60]);
  assert.equal(c.contact, "contact"); assert.equal(c.contactDetected, true);
});

test("energy expended and RR intervals in 1/1024 s", () => {
  // flags: u8 HR, contact detected, energy, RR
  const r = H.decodeHeartRate([0x1E, 65, 0x10, 0x27, 0x00, 0x04, 0x00, 0x02]);
  assert.equal(r.hr, 65); assert.equal(r.energyKJ, 10000);
  same(r.rrRaw, [1024, 512]);
  same(r.rrMs, [1000, 500]);
});

test("uint16 HR with RR and no energy", () => {
  const r = H.decodeHeartRate(new Uint8Array([0x11, 0x50, 0x00, 0x33, 0x03]));
  assert.equal(r.hr, 80); same(r.rrRaw, [0x0333]); near(r.rrMs[0], 819 * 1000 / 1024, 1e-9);
});

test("accepts DataView, ArrayBuffer and offset views", () => {
  const buf = new Uint8Array([9, 9, 0x00, 61, 9]).buffer;
  assert.equal(H.decodeHeartRate(new DataView(buf, 2, 2)).hr, 61);
  assert.equal(H.decodeHeartRate(new Uint8Array(buf, 2, 2)).hr, 61);
  assert.equal(H.decodeHeartRate(new Uint8Array([0, 62]).buffer).hr, 62);
});

test("truncated and malformed packets throw with codes", () => {
  throwsCode(() => H.decodeHeartRate([]), "short");
  throwsCode(() => H.decodeHeartRate([0x00]), "short");
  throwsCode(() => H.decodeHeartRate([0x01, 0x50]), "short");
  throwsCode(() => H.decodeHeartRate([0x08, 60, 0x01]), "short");
  throwsCode(() => H.decodeHeartRate([0, 256]), "byte");
  throwsCode(() => H.decodeHeartRate([0, -1]), "byte");
  throwsCode(() => H.decodeHeartRate([0, 1.5]), "byte");
  throwsCode(() => H.decodeHeartRate(["0", "60"]), "byte");
  throwsCode(() => H.decodeHeartRate(null), "input");
  throwsCode(() => H.decodeHeartRate("0060"), "input");
  throwsCode(() => H.decodeHeartRate({ length: 2, 0: 0, 1: 60 }), "input");
  throwsCode(() => H.decodeHeartRate(new Array(100000).fill(0)), "size");
});

test("odd trailing RR byte and reserved bits produce warnings, not errors", () => {
  const r = H.decodeHeartRate([0xF0, 60, 0x00, 0x04, 0x07]);
  same(r.rrRaw, [1024]);
  assert.equal(r.warnings.length, 2);
});

test("RR flag with no RR values warns", () => {
  const r = H.decodeHeartRate([0x10, 60]);
  same(r.rrRaw, []); assert.equal(r.warnings.length, 1);
});

test("rmssd of a known series", () => {
  // diffs: +20, -20, +20, -20 ... -> RMSSD 20
  const rr = []; for (let i = 0; i < 30; i++) rr.push(i % 2 ? 820 : 800);
  const r = H.rmssd(rr);
  near(r.rmssd, 20, 1e-9); assert.equal(r.pairs, 29); assert.equal(r.rejected, 0);
});

test("rmssd rejects ectopic beats and does not pair across them", () => {
  const rr = [];
  for (let i = 0; i < 30; i++) rr.push(i % 2 ? 820 : 800);
  rr.splice(10, 0, 400);      // premature beat
  rr.splice(20, 0, 1500);     // missed beat
  rr.splice(25, 0, NaN, 100, 5000);
  const r = H.rmssd(rr);
  assert.equal(r.rejected, 5);
  // Pairs straddling a rejected beat are skipped, so remaining diffs are still +/-20.
  near(r.rmssd, 20, 1e-9);
});

test("rmssd needs minPairs", () => {
  assert.equal(H.rmssd([800, 810, 820]).rmssd, null);
  near(H.rmssd([800, 810, 820], { minPairs: 2 }).rmssd, 10, 1e-9);
});

test("reference reseeds after a genuine rhythm change", () => {
  const rr = [];
  for (let i = 0; i < 10; i++) rr.push(1000);
  for (let i = 0; i < 20; i++) rr.push(600 + (i % 2) * 10);
  const c = H.cleanRr(rr);
  assert.ok(c.slice(-10).every((x) => x.ok), "later beats at the new rate are accepted");
});

test("first beat artifact does not poison the stream", () => {
  const rr = [350]; for (let i = 0; i < 20; i++) rr.push(900 + (i % 2) * 10);
  const c = H.cleanRr(rr);
  assert.ok(c.slice(-10).every((x) => x.ok));
});

test("rolling window keeps about windowMs of beats", () => {
  const w = H.rmssdWindow({ windowMs: 10000 });
  const rand = rng(1);
  let v;
  for (let i = 0; i < 200; i++) v = w.push([800 + Math.round((rand() - 0.5) * 40)]);
  assert.ok(v.windowMs <= 10000 + 1000 && v.windowMs >= 9000, "window " + v.windowMs);
  assert.ok(v.rmssd > 0 && v.rmssd < 40);
  near(v.hr, 75, 3);
  w.reset();
  assert.equal(w.value().beats, 0);
  assert.equal(w.value().rmssd, null);
});

test("rolling window caps beats and survives junk input", () => {
  const w = H.rmssdWindow({ windowMs: 1e9, maxBeats: 50 });
  for (let i = 0; i < 1000; i++) w.push(i % 2 ? 800 : 810);
  assert.equal(w.value().beats, 50);
  w.push([null, "x", {}, undefined, Infinity]);
  w.push(new Array(100000).fill(800));
  assert.equal(w.value().beats, 50);
  near(w.value().rmssd, 0, 1e-9, "constant 800 after the cap");
});

test("decoded RR feeds the window end to end", () => {
  const w = H.rmssdWindow({ minPairs: 3 });
  for (let i = 0; i < 6; i++) {
    const raw = i % 2 ? 1024 : 1044; // ~1000 ms and ~1019.5 ms
    const pkt = H.decodeHeartRate([0x10, 60, raw & 255, raw >> 8]);
    w.push(pkt.rrMs);
  }
  near(w.value().rmssd, 20 * 1000 / 1024, 1e-9);
});
