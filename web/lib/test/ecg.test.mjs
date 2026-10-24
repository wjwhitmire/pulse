import { test, load, near, throwsCode, assert, rng } from "./harness.mjs";
const E = load("ecg.js", "PulseECG");

// Synthetic single-lead ECG (microvolts): Gaussian P, Q, R, S, T waves per
// beat at known times, plus baseline wander, mains hum and white noise.
function synth({ fs = 512, seconds = 30, beats, tAmp = 350, rAmp = 1200, invert = false, noise = 20, seed = 1 }) {
  const rand = rng(seed), n = Math.round(fs * seconds), x = new Array(n).fill(0);
  const waves = [[-0.2, 150, 0.025], [-0.03, -100, 0.008], [0, rAmp, 0.01], [0.03, -250, 0.01], [0.28, tAmp, 0.06]];
  for (const bt of beats) {
    for (const [dt, amp, wd] of waves) {
      const c = (bt + dt) * fs, w = wd * fs, lo = Math.max(0, Math.floor(c - 5 * w)), hi = Math.min(n - 1, Math.ceil(c + 5 * w));
      for (let i = lo; i <= hi; i++) x[i] += amp * Math.exp(-0.5 * ((i - c) / w) ** 2);
    }
  }
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    x[i] += 300 * Math.sin(2 * Math.PI * 0.3 * t) + 50 * Math.sin(2 * Math.PI * 60 * t) + (rand() - 0.5) * 2 * noise * Math.sqrt(3);
    if (invert) x[i] = -x[i];
  }
  return x;
}
function regularBeats(bpm, seconds, start = 0.5) { const out = []; for (let t = start; t < seconds - 0.4; t += 60 / bpm) out.push(t); return out; }
function check(peaks, beats, fs, tolMs = 25) {
  assert.equal(peaks.length, beats.length, "beat count: got " + peaks.length + " expected " + beats.length);
  for (let i = 0; i < beats.length; i++) {
    const errMs = Math.abs(peaks[i] / fs - beats[i]) * 1000;
    assert.ok(errMs <= tolMs, "beat " + i + " off by " + errMs.toFixed(1) + " ms");
  }
}

for (const bpm of [45, 60, 75, 100, 150, 190]) {
  test("regular rhythm at " + bpm + " bpm", () => {
    const fs = 512, beats = regularBeats(bpm, 30);
    const x = synth({ fs, beats, seed: bpm });
    const peaks = E.detectRPeaks(x, fs);
    check(peaks, beats, fs);
    near(E.heartRate(peaks, fs).meanHr, bpm, 0.5);
  });
}

test("irregular rhythm with variable RR", () => {
  const rand = rng(3), beats = []; let t = 0.6;
  while (t < 29.5) { beats.push(t); t += 0.45 + rand() * 0.9; }
  const x = synth({ beats, seed: 11 });
  check(E.detectRPeaks(x, 512), beats, 512);
});

test("tall T waves are not counted as beats", () => {
  const beats = regularBeats(70, 30);
  const x = synth({ beats, tAmp: 700, seed: 5 });
  check(E.detectRPeaks(x, 512), beats, 512);
});

test("inverted lead and 250 Hz sample rate", () => {
  const beats = regularBeats(80, 20);
  check(E.detectRPeaks(synth({ fs: 250, seconds: 20, beats, invert: true, seed: 8 }), 250), beats, 250, 30);
});

test("amplitude drop is followed by the adaptive threshold", () => {
  const beats = regularBeats(65, 40);
  const x = synth({ seconds: 40, beats, seed: 9 });
  for (let i = 20 * 512; i < x.length; i++) x[i] *= 0.3;
  check(E.detectRPeaks(x, 512), beats, 512);
});

test("flat line, pure noise and short input give no beats", () => {
  assert.equal(E.detectRPeaks(new Array(5120).fill(0), 512).length, 0);
  assert.equal(E.detectRPeaks(new Array(100).fill(1), 512).length, 0);
  const hr = E.heartRate([], 512);
  assert.equal(hr.meanHr, null);
  const x = new Array(5120).fill(0).map((_, i) => (i % 7) - 3);
  x[1000] = NaN; x[2000] = Infinity;
  E.detectRPeaks(x, 512);
  throwsCode(() => E.detectRPeaks("x", 512), "input");
  throwsCode(() => E.detectRPeaks([1, 2, 3], 5), "rate");
});

function appleCsv(samples, extra = "") {
  return ["Name,\"Person, Test\"", "Date of Birth,\"Jan 1, 1980\"", "Recorded Date,2026-10-01 07:30:12 -0500",
    "Classification,Sinus Rhythm", "Symptoms,", "Software Version,2", "Device,\"Watch7,1\"", "Sample Rate,512 hertz",
    extra, "Lead,Lead I", "Unit,µV", "", ...samples.map((v) => v.toFixed(3))].join("\n");
}

test("Apple Health ECG CSV: header, privacy, samples, analysis", () => {
  const beats = regularBeats(72, 30);
  const x = synth({ beats, seed: 2 });
  const rec = E.parse(appleCsv(x));
  assert.equal(rec.format, "apple"); assert.equal(rec.sampleRate, 512);
  assert.equal(rec.meta.classification, "Sinus Rhythm");
  assert.equal(rec.meta.device, "Watch7,1");
  assert.equal(rec.meta.lead, "Lead I");
  assert.ok(!JSON.stringify(rec.meta).includes("Person"), "name is not kept");
  assert.ok(!JSON.stringify(rec.meta).includes("1980"), "birth date is not kept");
  assert.equal(rec.samples.length, x.length);
  const a = E.analyze(rec);
  check(a.peaks, beats, 512);
  near(a.heartRate.medianHr, 72, 0.5);
  assert.equal(a.deviceClassification, "Sinus Rhythm");
});

test("Apple CSV errors", () => {
  throwsCode(() => E.parseApple("Classification,Sinus Rhythm\nLead,Lead I\n\n1\n2\n"), "rate");
  throwsCode(() => E.parseApple(appleCsv([1, 2, 3])), "short");
  throwsCode(() => E.parse(42), "input");
  const rec = E.parseApple(appleCsv(new Array(600).fill(5)).replace("Unit,µV", "Unit,parsecs"));
  assert.equal(rec.warnings.length, 1);
});

test("generic CSV: time and value columns in seconds, mV header", () => {
  const fs = 250, x = synth({ fs, seconds: 10, beats: regularBeats(60, 10) });
  const text = "time,ecg_mv\n" + x.map((v, i) => (i / fs).toFixed(4) + "," + (v / 1000).toFixed(5)).join("\n");
  const rec = E.parse(text);
  assert.equal(rec.format, "generic"); near(rec.sampleRate, 250, 1e-6);
  near(rec.samples[100], x[100], 0.01);
});

test("generic CSV: ms time column, semicolons, tabs, key lines", () => {
  const rows = []; for (let i = 0; i < 600; i++) rows.push((i * 4) + ";" + (i % 10));
  near(E.parseGeneric("t_ms;value\n" + rows.join("\n")).sampleRate, 250, 1e-6);
  const kv = "sample rate,500\nunit,mV\n" + new Array(600).fill("0.5").join("\n");
  const r = E.parseGeneric(kv);
  assert.equal(r.sampleRate, 500); assert.equal(r.samples[0], 500);
  const tabs = new Array(600).fill("1\t2\t3").join("\n");
  assert.equal(E.parseGeneric(tabs, { sampleRate: 300, column: 2 }).samples[0], 3);
  throwsCode(() => E.parseGeneric(new Array(600).fill("1").join("\n")), "rate");
  throwsCode(() => E.parseGeneric("a,b\nc,d"), "format");
  throwsCode(() => E.parseGeneric("x".repeat(17 * 1024 * 1024)), "size");
});

test("paper scale", () => {
  const p = E.paperScale(512);
  assert.equal(p.mmPerSecond, 25); assert.equal(p.mmPerMillivolt, 10);
  near(p.mmPerSample * 512, 25, 1e-12);
  assert.equal(p.mmPerMicrovolt, 0.01);
});

test("heavier noise and a premature beat", () => {
  const beats = regularBeats(90, 30);
  beats.splice(10, 0, (beats[9] + beats[10]) / 2 - 0.05); // early beat
  const x = synth({ beats, noise: 80, seed: 21 });
  check(E.detectRPeaks(x, 512), beats, 512);
});
