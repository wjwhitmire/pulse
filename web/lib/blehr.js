// PulseBLEHR: Bluetooth Heart Rate Measurement (characteristic 0x2A37) decoder
// and live RMSSD over a rolling RR window. Pure functions: no DOM, no network,
// no storage. Field layout follows the Bluetooth SIG GATT Specification
// Supplement, section "Heart Rate Measurement" (see web/lib/README.md).
var PulseBLEHR = (function () {
  "use strict";

  var MAX_BYTES = 512; // largest ATT attribute value

  function err(code, message) { var e = new Error(message); e.code = code; return e; }

  // Accepts a DataView (what Web Bluetooth delivers), an ArrayBuffer, any
  // typed array, or a plain array of byte values. Returns a plain array.
  function toBytes(input) {
    if (input === null || input === undefined) throw err("input", "No data.");
    var tag = Object.prototype.toString.call(input);
    var out = [], i, n;
    if (tag === "[object DataView]") {
      n = input.byteLength;
      if (n > MAX_BYTES) throw err("size", "Packet is longer than " + MAX_BYTES + " bytes.");
      for (i = 0; i < n; i++) out.push(input.getUint8(i));
      return out;
    }
    if (tag === "[object ArrayBuffer]") {
      var u = new Uint8Array(input);
      if (u.length > MAX_BYTES) throw err("size", "Packet is longer than " + MAX_BYTES + " bytes.");
      for (i = 0; i < u.length; i++) out.push(u[i]);
      return out;
    }
    if (ArrayBuffer.isView(input)) {
      var v = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      if (v.length > MAX_BYTES) throw err("size", "Packet is longer than " + MAX_BYTES + " bytes.");
      for (i = 0; i < v.length; i++) out.push(v[i]);
      return out;
    }
    if (Array.isArray(input)) {
      if (input.length > MAX_BYTES) throw err("size", "Packet is longer than " + MAX_BYTES + " bytes.");
      for (i = 0; i < input.length; i++) {
        var b = input[i];
        if (typeof b !== "number" || !(b >= 0 && b <= 255) || Math.floor(b) !== b) throw err("byte", "Byte " + i + " is not a value from 0 to 255.");
        out.push(b);
      }
      return out;
    }
    throw err("input", "Expected bytes (DataView, ArrayBuffer, typed array or array).");
  }

  var CONTACT = ["unsupported", "unsupported", "no-contact", "contact"];

  // Decode one Heart Rate Measurement notification.
  // Layout: flags(u8) | HR (u8 or u16) | [energy expended u16, kJ] | [RR u16 ...]
  // Flags: bit0 HR is u16, bits1-2 sensor contact status, bit3 energy present,
  // bit4 RR intervals present, bits5-7 reserved. Little endian.
  function decodeHeartRate(input) {
    var b = toBytes(input);
    if (b.length < 2) throw err("short", "Heart rate packet is shorter than 2 bytes.");
    var flags = b[0], p = 1, warnings = [];
    var wide = (flags & 0x01) !== 0;
    var contactBits = (flags >> 1) & 0x03;
    var hasEnergy = (flags & 0x08) !== 0;
    var hasRr = (flags & 0x10) !== 0;
    if (flags & 0xE0) warnings.push("Reserved flag bits are set; they were ignored.");
    var hr;
    if (wide) {
      if (b.length < p + 2) throw err("short", "Flags say 16-bit heart rate but the packet ends early.");
      hr = b[p] | (b[p + 1] << 8); p += 2;
    } else { hr = b[p]; p += 1; }
    var energy = null;
    if (hasEnergy) {
      if (b.length < p + 2) throw err("short", "Flags say energy expended is present but the packet ends early.");
      energy = b[p] | (b[p + 1] << 8); p += 2;
    }
    var rrRaw = [];
    if (hasRr) {
      while (p + 1 < b.length) { rrRaw.push(b[p] | (b[p + 1] << 8)); p += 2; }
      if (!rrRaw.length) warnings.push("Flags say RR intervals are present but none were sent.");
    }
    if (p < b.length) warnings.push((b.length - p) + " trailing byte(s) ignored.");
    var rrMs = [];
    for (var i = 0; i < rrRaw.length; i++) rrMs.push(rrRaw[i] * 1000 / 1024);
    return {
      flags: flags,
      format: wide ? "uint16" : "uint8",
      hr: hr,
      contact: CONTACT[contactBits],
      contactSupported: contactBits >= 2,
      contactDetected: contactBits === 3 ? true : (contactBits === 2 ? false : null),
      energyKJ: energy,
      rrRaw: rrRaw,          // units of 1/1024 s, as sent
      rrMs: rrMs,            // milliseconds
      warnings: warnings
    };
  }

  // ---------------------------------------------------------------- RR / RMSSD
  var RR_DEFAULTS = {
    minRr: 300,          // ms (200 bpm)
    maxRr: 2000,         // ms (30 bpm)
    maxDeviation: 0.20,  // reject beats more than 20% off the recent median
    refBeats: 5,         // beats in the reference median
    windowMs: 60000,     // rolling window length (sum of RR)
    maxBeats: 300,       // hard cap on stored beats
    minPairs: 10         // successive pairs needed before RMSSD is reported
  };

  function opt(o, k) { return o && Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === "number" && isFinite(o[k]) ? o[k] : RR_DEFAULTS[k]; }
  function median(xs) {
    var s = xs.slice().sort(function (a, b) { return a - b; });
    var n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  // Classify a sequence of RR intervals (ms). Returns one entry per input:
  // { rr, ok, reason, gap } where gap=true means the beat before it was
  // rejected, so the pair (previous accepted, this) is not used for RMSSD.
  function cleanRr(rrMs, opts) {
    if (!Array.isArray(rrMs)) throw err("input", "RR intervals must be an array.");
    var st = newState(opts);
    var out = [];
    for (var i = 0; i < rrMs.length; i++) out.push(classify(st, rrMs[i]));
    return out;
  }

  function newState(opts) {
    return {
      o: {
        minRr: opt(opts, "minRr"), maxRr: opt(opts, "maxRr"), maxDeviation: opt(opts, "maxDeviation"),
        refBeats: Math.max(1, Math.floor(opt(opts, "refBeats"))), windowMs: opt(opts, "windowMs"),
        maxBeats: Math.max(2, Math.floor(opt(opts, "maxBeats"))), minPairs: Math.max(1, Math.floor(opt(opts, "minPairs")))
      },
      ref: [],        // recent accepted beats
      rejectRun: [],  // consecutive rejected-for-deviation beats
      lastOk: false
    };
  }

  function classify(st, rr) {
    var o = st.o;
    if (typeof rr !== "number" || !isFinite(rr)) { st.lastOk = false; return { rr: null, ok: false, reason: "not-a-number", gap: true }; }
    if (rr < o.minRr || rr > o.maxRr) { st.lastOk = false; st.rejectRun = []; return { rr: rr, ok: false, reason: "out-of-range", gap: true }; }
    var gap = !st.lastOk;
    if (st.ref.length) {
      var m = median(st.ref);
      if (Math.abs(rr - m) > o.maxDeviation * m) {
        // If the rhythm genuinely shifted (or the first reference beat was an
        // artifact), several consistent "rejected" beats in a row reseed the
        // reference instead of rejecting forever.
        st.rejectRun.push(rr);
        st.lastOk = false;
        if (st.rejectRun.length >= o.refBeats) {
          var rm = median(st.rejectRun), consistent = true;
          for (var j = 0; j < st.rejectRun.length; j++) if (Math.abs(st.rejectRun[j] - rm) > o.maxDeviation * rm) consistent = false;
          if (consistent) { st.ref = st.rejectRun.slice(-o.refBeats); st.rejectRun = []; }
          else st.rejectRun.shift();
        }
        return { rr: rr, ok: false, reason: "deviation", gap: true };
      }
    }
    st.rejectRun = [];
    st.ref.push(rr);
    if (st.ref.length > o.refBeats) st.ref.shift();
    st.lastOk = true;
    return { rr: rr, ok: true, reason: null, gap: gap };
  }

  function rmssdOf(beats, minPairs) {
    var s = 0, n = 0;
    for (var i = 1; i < beats.length; i++) {
      if (!beats[i].gap) { var d = beats[i].rr - beats[i - 1].rr; s += d * d; n++; }
    }
    return { rmssd: n >= minPairs ? Math.sqrt(s / n) : null, pairs: n };
  }

  // One-shot RMSSD of an RR series (ms) with artifact rejection.
  function rmssd(rrMs, opts) {
    var st = newState(opts);
    var kept = [], rejected = 0;
    if (!Array.isArray(rrMs)) throw err("input", "RR intervals must be an array.");
    for (var i = 0; i < rrMs.length; i++) {
      var c = classify(st, rrMs[i]);
      if (c.ok) kept.push(c); else rejected++;
    }
    var r = rmssdOf(kept, st.o.minPairs);
    return { rmssd: r.rmssd, pairs: r.pairs, accepted: kept.length, rejected: rejected };
  }

  // Rolling window for live use. push() takes the rrMs array from each
  // decoded notification. State is held in the returned object only.
  function rmssdWindow(opts) {
    var st = newState(opts);
    var beats = [], total = 0, accepted = 0, rejected = 0;
    function trim() {
      while (beats.length > st.o.maxBeats || (beats.length > 1 && total - beats[0].rr > st.o.windowMs)) {
        total -= beats[0].rr;
        beats.shift();
        if (beats.length) beats[0] = { rr: beats[0].rr, ok: true, reason: null, gap: true };
      }
    }
    return {
      push: function (rrList) {
        var list = Array.isArray(rrList) ? rrList : [rrList];
        if (list.length > 64) list = list.slice(-64); // a notification never carries this many
        for (var i = 0; i < list.length; i++) {
          var c = classify(st, list[i]);
          if (c.ok) { beats.push(c); total += c.rr; accepted++; } else rejected++;
        }
        trim();
        return this.value();
      },
      value: function () {
        var r = rmssdOf(beats, st.o.minPairs);
        var hr = beats.length ? 60000 * beats.length / total : null;
        return { rmssd: r.rmssd, pairs: r.pairs, beats: beats.length, windowMs: total, hr: hr, accepted: accepted, rejected: rejected };
      },
      reset: function () { st = newState(opts); beats = []; total = 0; accepted = 0; rejected = 0; }
    };
  }

  return Object.freeze({
    SERVICE_UUID: 0x180D,
    CHARACTERISTIC_UUID: 0x2A37,
    toBytes: toBytes,
    decodeHeartRate: decodeHeartRate,
    cleanRr: cleanRr,
    rmssd: rmssd,
    rmssdWindow: rmssdWindow
  });
})();
