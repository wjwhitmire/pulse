import { test, load, same, near, throwsCode, assert } from "./harness.mjs";
const B = load("blebp.js", "PulseBLEBP");
const le = (v) => [v & 255, (v >> 8) & 255];

test("SFLOAT decode: plain, negative exponent, negative mantissa", () => {
  assert.equal(B.decodeSfloat(0x0078).value, 120);        // 120e0
  assert.equal(B.decodeSfloat(0xF4B5).value, 120.5);      // 1205e-1
  assert.equal(B.decodeSfloat(0x0FFF).value, -1);         // mantissa -1
  assert.equal(B.decodeSfloat(0x1001).value, 10);         // 1e1
  assert.equal(B.decodeSfloat(0x8001).value, 1e-8);       // exponent -8
  assert.equal(B.decodeSfloat(0x7001).value, 1e7);        // exponent 7
  assert.equal(B.decodeSfloat(0xE7D0).value, 20);         // 2000e-2
});

test("SFLOAT special codes", () => {
  same(B.decodeSfloat(0x07FF), { value: null, special: "nan", raw: 0x07FF });
  same(B.decodeSfloat(0x0800), { value: null, special: "nres", raw: 0x0800 });
  assert.equal(B.decodeSfloat(0x07FE).value, Infinity);
  assert.equal(B.decodeSfloat(0x0802).value, -Infinity);
  assert.equal(B.decodeSfloat(0x0801).special, "reserved");
  // Same mantissa bits with a nonzero exponent are ordinary numbers.
  assert.equal(B.decodeSfloat(0x17FF).special, null);
  assert.equal(B.decodeSfloat(0x17FF).value, 20470);
});

test("SFLOAT encode round trip", () => {
  for (const [v, e] of [[120, 0], [120.5, -1], [-45.2, -1], [-20.46, -2], [0, 0], [2045, 0], [1.5e6, 3]]) {
    near(B.decodeSfloat(B.encodeSfloat(v, e)).value, v, 1e-9);
  }
  throwsCode(() => B.encodeSfloat(5000, 0), "sfloat");
  throwsCode(() => B.encodeSfloat(1, 9), "sfloat");
  throwsCode(() => B.encodeSfloat(2046, 0), "sfloat");
  throwsCode(() => B.decodeSfloat(70000), "sfloat");
  throwsCode(() => B.decodeSfloat("1"), "sfloat");
});

test("minimal mmHg measurement", () => {
  const r = B.decodeBloodPressure([0x00, ...le(121), ...le(79), ...le(93)]);
  assert.equal(r.unit, "mmHg");
  assert.equal(r.systolic, 121); assert.equal(r.diastolic, 79); assert.equal(r.meanArterial, 93);
  assert.equal(r.systolicMmHg, 121);
  assert.equal(r.timestamp, null); assert.equal(r.pulseRate, null); assert.equal(r.userId, null); assert.equal(r.status, null);
});

test("kPa unit converts to mmHg", () => {
  const s = B.encodeSfloat(16.1, -1), d = B.encodeSfloat(10.5, -1), m = B.encodeSfloat(12.4, -1);
  const r = B.decodeBloodPressure([0x01, ...le(s), ...le(d), ...le(m)]);
  assert.equal(r.unit, "kPa");
  near(r.systolic, 16.1, 1e-12);
  near(r.systolicMmHg, 120.76, 0.01);
});

test("all optional fields", () => {
  const bytes = [0x1E, ...le(B.encodeSfloat(118, 0)), ...le(B.encodeSfloat(76, 0)), ...le(B.encodeSfloat(90, 0)),
    ...le(2026), 10, 21, 7, 5, 9,
    ...le(B.encodeSfloat(64, 0)),
    3,
    ...le(0b101101)];
  const r = B.decodeBloodPressure(bytes);
  same(r.timestamp, { year: 2026, month: 10, day: 21, hours: 7, minutes: 5, seconds: 9, valid: true, local: "2026-10-21T07:05:09" });
  assert.equal(r.pulseRate, 64);
  assert.equal(r.userId, 3); assert.equal(r.userKnown, true);
  same(r.status, { raw: 45, bodyMovement: true, cuffTooLoose: false, irregularPulse: true, pulseRateRange: "above-upper-limit", improperPosition: true });
  same(r.warnings, []);
});

test("pulse rate range codes and unknown user", () => {
  const base = [0x18, ...le(120), ...le(80), ...le(95), 255];
  assert.equal(B.decodeBloodPressure([...base, ...le(0 << 3)]).status.pulseRateRange, "in-range");
  assert.equal(B.decodeBloodPressure([...base, ...le(2 << 3)]).status.pulseRateRange, "below-lower-limit");
  assert.equal(B.decodeBloodPressure([...base, ...le(3 << 3)]).status.pulseRateRange, "reserved");
  assert.equal(B.decodeBloodPressure([...base, ...le(0)]).userKnown, false);
  assert.equal(B.decodeBloodPressure([...base, ...le(0x8000)]).warnings.length, 1);
});

test("NaN systolic and NRes MAP are reported, not invented", () => {
  const r = B.decodeBloodPressure([0x00, ...le(0x07FF), ...le(80), ...le(0x0800)]);
  assert.equal(r.systolic, null); assert.equal(r.special.systolic, "nan");
  assert.equal(r.meanArterial, null); assert.equal(r.special.meanArterial, "nres");
  assert.equal(r.systolicMmHg, null);
  const inf = B.decodeBloodPressure([0x00, ...le(0x07FE), ...le(80), ...le(90)]);
  assert.equal(inf.systolic, Infinity); assert.equal(inf.systolicMmHg, null);
});

test("unknown and invalid time stamps", () => {
  const unk = B.decodeDateTime([0, 0, 0, 0, 0, 0, 0]);
  assert.equal(unk.valid, true); assert.equal(unk.local, null);
  const bad = B.decodeDateTime([...le(2026), 2, 30, 25, 61, 61]);
  assert.equal(bad.valid, false); assert.equal(bad.local, null);
  assert.equal(B.decodeDateTime([...le(2024), 2, 29, 0, 0, 0]).local, "2024-02-29T00:00:00");
  assert.equal(B.decodeDateTime([...le(2025), 2, 29, 0, 0, 0]).valid, false);
  const r = B.decodeBloodPressure([0x02, ...le(120), ...le(80), ...le(95), ...le(2026), 13, 1, 0, 0, 0]);
  assert.equal(r.timestamp.valid, false); assert.equal(r.warnings.length, 1);
});

test("truncation at every optional field throws", () => {
  throwsCode(() => B.decodeBloodPressure([0, 1, 2, 3, 4, 5]), "short");
  throwsCode(() => B.decodeBloodPressure([0x02, ...le(120), ...le(80), ...le(95), 1, 2, 3]), "short");
  throwsCode(() => B.decodeBloodPressure([0x04, ...le(120), ...le(80), ...le(95), 1]), "short");
  throwsCode(() => B.decodeBloodPressure([0x08, ...le(120), ...le(80), ...le(95)]), "short");
  throwsCode(() => B.decodeBloodPressure([0x10, ...le(120), ...le(80), ...le(95), 1]), "short");
  throwsCode(() => B.decodeBloodPressure(new Uint8Array(4096)), "size");
  throwsCode(() => B.decodeBloodPressure([0, 1, 2, 3, 4, 5, "6"]), "byte");
});

test("reserved flags and trailing bytes warn", () => {
  const r = B.decodeBloodPressure([0xE0, ...le(120), ...le(80), ...le(95), 9, 9]);
  assert.equal(r.warnings.length, 2);
  assert.equal(r.systolic, 120);
});

test("random bytes never crash with anything but a coded error", () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 2000; i++) {
    const n = Math.floor(rand() * 24);
    const bytes = Array.from({ length: n }, () => Math.floor(rand() * 256));
    try { B.decodeBloodPressure(bytes); } catch (e) { assert.ok(e.code, "uncoded error " + e.message); }
  }
});
