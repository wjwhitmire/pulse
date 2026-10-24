// PulseECG: parse Apple Health electrocardiogram CSV (and generic single-lead
// CSV), detect R peaks with a Pan-Tompkins style detector, and compute heart
// rate from RR intervals. Pure functions. No diagnosis: the device's own
// classification is passed through as text, nothing is inferred.
var PulseECG = (function () {
  "use strict";

  var MAX_TEXT = 16 * 1024 * 1024, MAX_SAMPLES = 2000000;
  function err(code, message) { var e = new Error(message); e.code = code; return e; }

  // ------------------------------------------------------------ CSV
  function splitCsv(line, sep) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (q) {
        if (ch === '"') { if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }
  var NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  function num(s) { s = String(s).trim().replace(/^−/, "-"); return NUM.test(s) ? parseFloat(s) : null; }
  function clean(s) { return String(s).replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, 200); }

  function lines(text) {
    if (typeof text !== "string") throw err("input", "Expected CSV text.");
    if (text.length > MAX_TEXT) throw err("size", "The file is over the size limit.");
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return text.split(/\r\n|\r|\n/);
  }

  // Microvolt scale factor from a unit label.
  function unitScale(u) {
    var s = String(u || "").toLowerCase().replace(/\s/g, "");
    if (/^(µ|μ|u|micro)v/.test(s) || s === "microvolts") return 1;
    if (/^(mv|millivolts?)$/.test(s)) return 1000;
    if (/^(v|volts?)$/.test(s)) return 1e6;
    return null;
  }
  function parseRate(v) {
    var m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(hz|hertz)?\s*$/i.exec(String(v));
    if (!m) return null;
    var r = parseFloat(m[1]);
    return r >= 50 && r <= 10000 ? r : null;
  }

  var APPLE_KEYS = {
    "recorded date": "recordedDate", "classification": "classification", "symptoms": "symptoms",
    "software version": "softwareVersion", "device": "device", "sample rate": "sampleRate", "lead": "lead", "unit": "unit"
  };
  // Name and Date of Birth lines are read past and not kept.

  // Apple Health electrocardiograms/*.csv: "Key,Value" header lines (Name,
  // Date of Birth, Recorded Date, Classification, Symptoms, Software Version,
  // Device, Sample Rate "512 hertz", Lead, Unit "µV"), a blank line, then one
  // sample per line.
  function parseApple(text) {
    var ls = lines(text), meta = {}, i = 0, warnings = [];
    for (; i < ls.length; i++) {
      var line = ls[i].trim();
      if (!line) continue;
      var first = splitCsv(line, ",");
      if (num(first[0]) !== null) break;
      var key = first[0].toLowerCase();
      if (Object.prototype.hasOwnProperty.call(APPLE_KEYS, key)) meta[APPLE_KEYS[key]] = clean(first.slice(1).join(", "));
      if (i > 200) throw err("format", "No ECG samples found after the header.");
    }
    var fs = parseRate(meta.sampleRate);
    if (fs === null) throw err("rate", "The file has no usable Sample Rate line.");
    var scale = meta.unit ? unitScale(meta.unit) : 1;
    if (scale === null) { warnings.push("Unknown unit '" + meta.unit + "'; samples treated as microvolts."); scale = 1; }
    var samples = [], bad = 0;
    for (; i < ls.length; i++) {
      var s = ls[i].trim();
      if (!s) continue;
      var v = num(splitCsv(s, ",")[0]);
      if (v === null) { bad++; continue; }
      samples.push(v * scale);
      if (samples.length > MAX_SAMPLES) throw err("size", "The recording has too many samples.");
    }
    if (bad) warnings.push(bad + " non-numeric sample line(s) skipped.");
    if (samples.length < fs) throw err("short", "The recording is shorter than one second.");
    return {
      format: "apple",
      sampleRate: fs,
      samples: samples,
      durationS: samples.length / fs,
      meta: {
        recordedDate: meta.recordedDate || null, classification: meta.classification || null, symptoms: meta.symptoms || null,
        softwareVersion: meta.softwareVersion || null, device: meta.device || null, lead: meta.lead || null, unit: "µV"
      },
      warnings: warnings
    };
  }

  // Generic single-lead CSV. Accepts:
  //  - optional "sample rate,250" style key lines, or opts.sampleRate;
  //  - one value column, or time + value columns (time in s or ms; the sample
  //    rate is then derived from the median time step);
  //  - an optional header row. opts.unit "uV" (default) or "mV" or "V", or a
  //    unit found in the header ("ecg_mv", "lead I (mV)").
  function parseGeneric(text, opts) {
    var ls = lines(text), warnings = [], fs = null, header = null, rows = [];
    var o = opts && typeof opts === "object" ? opts : {};
    if (typeof o.sampleRate === "number") fs = parseRate(o.sampleRate);
    var unit = typeof o.unit === "string" ? unitScale(o.unit) : null;
    for (var i = 0; i < ls.length; i++) {
      var line = ls[i].trim();
      if (!line || line.charAt(0) === "#") continue;
      var sep = line.indexOf("\t") >= 0 ? "\t" : (line.indexOf(";") >= 0 && line.indexOf(",") < 0 ? ";" : ",");
      var cells = splitCsv(line, sep);
      var nums = cells.map(num);
      if (nums.every(function (x) { return x !== null; })) { rows.push(nums); if (rows.length > MAX_SAMPLES) throw err("size", "The recording has too many samples."); continue; }
      if (rows.length) { warnings.push("Line " + (i + 1) + " is not numeric and was skipped."); continue; }
      var k = cells[0].toLowerCase();
      if (/sample\s*rate|sampling\s*rate|^fs$|^hz$/.test(k) && cells.length > 1) { var r = parseRate(cells[1]); if (r) fs = r; continue; }
      if (/^unit/.test(k) && cells.length > 1) { var us = unitScale(cells[1]); if (us !== null) unit = us; continue; }
      header = cells.map(function (c) { return c.toLowerCase(); });
    }
    if (!rows.length) throw err("format", "No numeric samples found.");
    var width = rows[0].length, tcol = -1, vcol = 0;
    if (header) {
      for (var h = 0; h < header.length; h++) if (/^(time|timestamp|seconds|sec|ms|t)([_\s(]|$)/.test(header[h])) { tcol = h; break; }
      if (unit === null) for (h = 0; h < header.length; h++) {
        if (/m\s*v\b|millivolt/.test(header[h])) { unit = 1000; break; }
        if (/(µ|μ|u)v\b|microvolt/.test(header[h])) { unit = 1; break; }
      }
    } else if (width >= 2 && fs === null) tcol = 0;
    if (tcol >= 0) vcol = tcol === 0 ? 1 : 0;
    if (typeof o.column === "number" && o.column >= 0 && o.column < width && o.column !== tcol) vcol = Math.floor(o.column);
    if (vcol >= width) throw err("format", "No value column found.");
    var samples = [], times = [];
    for (i = 0; i < rows.length; i++) {
      if (rows[i].length <= vcol) continue;
      samples.push(rows[i][vcol]);
      if (tcol >= 0) times.push(rows[i][tcol]);
    }
    if (fs === null && times.length > 2) {
      var d = [];
      for (i = 1; i < times.length && i < 5000; i++) d.push(times[i] - times[i - 1]);
      d.sort(function (a, b) { return a - b; });
      var md = d[d.length >> 1];
      var isMs = header && header[tcol] && /ms/.test(header[tcol]);
      if (!isMs && md >= 0.5) isMs = true; // a step of 0.5 or more cannot be seconds at 50 Hz or faster
      fs = parseRate(isMs ? 1000 / md : 1 / md);
    }
    if (fs === null) throw err("rate", "Give the sample rate (Hz): the file does not state it.");
    var scale = unit === null ? 1 : unit;
    for (i = 0; i < samples.length; i++) samples[i] *= scale;
    if (samples.length < fs) throw err("short", "The recording is shorter than one second.");
    return { format: "generic", sampleRate: fs, samples: samples, durationS: samples.length / fs, meta: { classification: null, unit: "µV" }, warnings: warnings };
  }

  function parse(text, opts) {
    var head = typeof text === "string" ? text.slice(0, 4000).toLowerCase() : "";
    return /(^|\n)\s*"?sample rate"?\s*,\s*"?\d/.test(head) && /(^|\n)\s*"?(recorded date|classification|lead)"?\s*,/.test(head) ? parseApple(text) : parseGeneric(text, opts);
  }

  // ------------------------------------------------------------ filters
  // RBJ audio-EQ cookbook biquads, Q = 1/sqrt(2) (Butterworth).
  function biquad(type, f0, fs) {
    var w = 2 * Math.PI * f0 / fs, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
    var b0, b1, b2, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
    if (type === "low") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  function runBiquad(x, k) {
    var y = new Float64Array(x.length), x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var v = k[0] * x[i] + k[1] * x1 + k[2] * x2 - k[3] * y1 - k[4] * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  function reverse(a) { var r = new Float64Array(a.length); for (var i = 0; i < a.length; i++) r[i] = a[a.length - 1 - i]; return r; }
  // Zero-phase band-pass (forward-backward), with odd reflection padding to
  // tame the edge transients.
  function bandpass(x, fs, lo, hi) {
    var n = x.length, pad = Math.min(n - 1, Math.round(fs));
    var ext = new Float64Array(n + 2 * pad);
    for (var i = 0; i < pad; i++) ext[i] = 2 * x[0] - x[pad - i];
    for (i = 0; i < n; i++) ext[pad + i] = x[i];
    for (i = 0; i < pad; i++) ext[pad + n + i] = 2 * x[n - 1] - x[n - 2 - i];
    var hp = biquad("high", lo, fs), lp = biquad("low", hi, fs);
    var y = runBiquad(runBiquad(ext, hp), lp);
    y = reverse(runBiquad(runBiquad(reverse(y), hp), lp));
    return y.subarray(pad, pad + n);
  }

  // Detect R peaks. samples: microvolts; fs: Hz. Returns sample indices.
  // Steps (Pan and Tompkins 1985): 5-15 Hz band-pass, five-point derivative,
  // squaring, 150 ms moving-window integration, adaptive signal/noise
  // thresholds with a 200 ms refractory period, 360 ms T-wave slope check and
  // search-back at 1.66 x the mean RR interval.
  function detectRPeaks(samples, fs, opts) {
    if (!Array.isArray(samples) && !ArrayBuffer.isView(samples)) throw err("input", "Samples must be an array.");
    if (typeof fs !== "number" || !(fs >= 50 && fs <= 10000)) throw err("rate", "Sample rate must be 50 to 10000 Hz.");
    var n = samples.length;
    if (n > MAX_SAMPLES) throw err("size", "Too many samples.");
    if (n < fs) return [];
    var x = new Float64Array(n);
    for (var i = 0; i < n; i++) { var v = samples[i]; x[i] = typeof v === "number" && isFinite(v) ? v : (i ? x[i - 1] : 0); }
    var o = opts && typeof opts === "object" ? opts : {};
    var bp = bandpass(x, fs, typeof o.lowHz === "number" ? o.lowHz : 5, typeof o.highHz === "number" ? o.highHz : 15);

    // Centered five-point derivative, squared.
    var sq = new Float64Array(n);
    for (i = 2; i < n - 2; i++) { var d = (-bp[i - 2] - 2 * bp[i - 1] + 2 * bp[i + 1] + bp[i + 2]) * fs / 8; sq[i] = d * d; }
    // Centered 150 ms moving-window integration.
    var w = Math.max(1, Math.round(0.15 * fs)), half = w >> 1, mwi = new Float64Array(n);
    var cs = new Float64Array(n + 1);
    for (i = 0; i < n; i++) cs[i + 1] = cs[i] + sq[i];
    for (i = 0; i < n; i++) { var a = Math.max(0, i - half), b = Math.min(n, i + half + 1); mwi[i] = (cs[b] - cs[a]) / (b - a); }

    var refr = Math.round(0.2 * fs), tWin = Math.round(0.36 * fs), loc = Math.round(0.1 * fs);
    // Candidate peaks: local maxima of the integrated signal, at most one per refractory period.
    var cand = [];
    for (i = 1; i < n - 1; i++) {
      if (mwi[i] > mwi[i - 1] && mwi[i] >= mwi[i + 1]) {
        var last = cand[cand.length - 1];
        if (last !== undefined && i - last < refr) { if (mwi[i] > mwi[last]) cand[cand.length - 1] = i; }
        else cand.push(i);
      }
    }
    if (!cand.length) return [];
    function slope(k) {
      var m = 0;
      for (var j = Math.max(1, k - loc); j < Math.min(n, k + loc); j++) m = Math.max(m, Math.abs(bp[j] - bp[j - 1]));
      return m;
    }
    // Learning phase: first 2 s.
    var learn = Math.min(n, Math.round(2 * fs)), mx = 0, mean = 0;
    for (i = 0; i < learn; i++) { mx = Math.max(mx, mwi[i]); mean += mwi[i]; }
    mean /= learn;
    var spki = 0.5 * mx, npki = 0.5 * mean;
    if (!(mx > 0)) return [];
    var qrs = [], rr = [], noise = [];
    function thr() { return npki + 0.25 * (spki - npki); }
    function accept(k, viaSearchBack) {
      if (qrs.length) { rr.push(k - qrs[qrs.length - 1]); if (rr.length > 8) rr.shift(); }
      qrs.push(k);
      spki = viaSearchBack ? 0.25 * mwi[k] + 0.75 * spki : 0.125 * mwi[k] + 0.875 * spki;
    }
    function meanRr() { var t = 0; for (var r = 0; r < rr.length; r++) t += rr[r]; return t / rr.length; }
    for (var c = 0; c < cand.length; c++) {
      var k = cand[c], p = mwi[k];
      // Search back: once 1.66 x the mean RR has passed with no beat, take the
      // largest earlier candidate if it clears half the threshold, or if it
      // stands above the noise estimate and is not trivially small. The second
      // rule lets the threshold follow a sudden drop in QRS amplitude.
      while (qrs.length && rr.length >= 2 && k - qrs[qrs.length - 1] > 1.66 * meanRr() && noise.length) {
        var prev0 = qrs[qrs.length - 1], best = -1;
        for (var q = 0; q < noise.length; q++) {
          var nk = noise[q];
          if (nk - prev0 >= refr && k - nk >= refr && (best < 0 || mwi[nk] > mwi[best])) best = nk;
        }
        if (best < 0) break;
        var pb = mwi[best];
        if (!(pb > 0.5 * thr() || (pb > npki && pb > 0.05 * spki))) break;
        accept(best, true);
        noise = noise.filter(function (z) { return z > best; });
      }
      if (p > thr()) {
        var prev = qrs[qrs.length - 1];
        if (prev !== undefined && k - prev < tWin && slope(k) < 0.5 * slope(prev)) {
          npki = 0.125 * p + 0.875 * npki; // T wave
          noise.push(k);
          continue;
        }
        accept(k, false);
        noise = [];
      } else {
        npki = 0.125 * p + 0.875 * npki;
        noise.push(k);
      }
    }
    // Locate each R peak on the band-passed signal near the integrated peak.
    var out = [];
    for (i = 0; i < qrs.length; i++) {
      var k0 = qrs[i], bi = k0, bv = -1;
      for (var j = Math.max(0, k0 - loc); j < Math.min(n, k0 + loc); j++) if (Math.abs(bp[j]) > bv) { bv = Math.abs(bp[j]); bi = j; }
      if (out.length && bi - out[out.length - 1] < refr) { if (Math.abs(bp[bi]) > Math.abs(bp[out[out.length - 1]])) out[out.length - 1] = bi; }
      else out.push(bi);
    }
    return out;
  }

  // Heart rate from R-peak indices. RR outside 0.25 to 3 s is dropped.
  function heartRate(peaks, fs) {
    if (!Array.isArray(peaks)) throw err("input", "Peaks must be an array.");
    var rr = [];
    for (var i = 1; i < peaks.length; i++) {
      var s = (peaks[i] - peaks[i - 1]) / fs;
      if (s >= 0.25 && s <= 3) rr.push(s);
    }
    if (!rr.length) return { beats: peaks.length, rrMs: [], meanHr: null, medianHr: null, minHr: null, maxHr: null };
    var sum = 0, srt = rr.slice().sort(function (a, b) { return a - b; });
    for (i = 0; i < rr.length; i++) sum += rr[i];
    var med = srt.length % 2 ? srt[(srt.length - 1) / 2] : (srt[srt.length / 2 - 1] + srt[srt.length / 2]) / 2;
    return {
      beats: peaks.length,
      rrMs: rr.map(function (s) { return s * 1000; }),
      meanHr: 60 / (sum / rr.length),
      medianHr: 60 / med,
      minHr: 60 / srt[srt.length - 1],
      maxHr: 60 / srt[0]
    };
  }

  function analyze(record, opts) {
    if (!record || typeof record !== "object") throw err("input", "Expected a parsed ECG record.");
    var peaks = detectRPeaks(record.samples, record.sampleRate, opts);
    var hr = heartRate(peaks, record.sampleRate);
    return { peaks: peaks, heartRate: hr, durationS: record.samples.length / record.sampleRate, deviceClassification: record.meta ? record.meta.classification : null };
  }

  // Standard ECG paper: 25 mm/s and 10 mm/mV.
  function paperScale(fs) {
    if (typeof fs !== "number" || !(fs > 0)) throw err("rate", "Sample rate must be positive.");
    return { mmPerSecond: 25, mmPerMillivolt: 10, mmPerSample: 25 / fs, mmPerMicrovolt: 0.01, smallBoxMm: 1, largeBoxMm: 5 };
  }

  return Object.freeze({
    parse: parse,
    parseApple: parseApple,
    parseGeneric: parseGeneric,
    bandpass: function (x, fs, lo, hi) { return Array.prototype.slice.call(bandpass(Float64Array.from(x), fs, lo || 5, hi || 15)); },
    detectRPeaks: detectRPeaks,
    heartRate: heartRate,
    analyze: analyze,
    paperScale: paperScale
  });
})();
