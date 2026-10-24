"use strict";
// Pulse core: pure functions, no DOM access. Mirrors the Python package src/pulse
// line for line so web/parity.test.mjs can check both against tests/vectors.json.
const SB = (() => {
  const EARTH_R = 6371008.8;
  function err(code, message) { const e = new Error(message); e.code = code; return e; }

  // ------------------------------------------------------------------ util
  const NUM = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
  function num(s) {
    if (s === null || s === undefined) return null;
    if (typeof s === "number") return Number.isFinite(s) ? s : null;
    if (!NUM.test(s)) return null;
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  }
  const fdiv = (a, b) => Math.floor(a / b);
  function daysFromCivil(y, m, d) {
    y -= m <= 2 ? 1 : 0;
    const era = fdiv(y >= 0 ? y : y - 399, 400);
    const yoe = y - era * 400;
    const doy = fdiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;
    const doe = yoe * 365 + fdiv(yoe, 4) - fdiv(yoe, 100) + doy;
    return era * 146097 + doe - 719468;
  }
  function civilFromDays(z) {
    z += 719468;
    const era = fdiv(z >= 0 ? z : z - 146096, 146097);
    const doe = z - era * 146097;
    const yoe = fdiv(doe - fdiv(doe, 1460) + fdiv(doe, 36524) - fdiv(doe, 146096), 365);
    const y = yoe + era * 400;
    const doy = doe - (365 * yoe + fdiv(yoe, 4) - fdiv(yoe, 100));
    const mp = fdiv(5 * doy + 2, 153);
    const d = doy - fdiv(153 * mp + 2, 5) + 1;
    const m = mp + (mp < 10 ? 3 : -9);
    return [y + (m <= 2 ? 1 : 0), m, d];
  }
  const pad = (n, w) => String(n).padStart(w, "0");
  function dayStr(z) { const [y, m, d] = civilFromDays(z); return pad(y, 4) + "-" + pad(m, 2) + "-" + pad(d, 2); }
  const DATE = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/;
  function parseDay(s) {
    const m = DATE.exec(s || "");
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    const z = daysFromCivil(y, mo, d), c = civilFromDays(z);
    return c[0] === y && c[1] === mo && c[2] === d ? z : null;
  }
  const ISO = /^\s*(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)\s*([Zz]|[+-]\d{2}:?\d{2})?\s*$/;
  function parseTime(s) {
    if (s === null || s === undefined) return null;
    const m = ISO.exec(s);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mi = +m[5];
    const sec = parseFloat(m[6]);
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && hh <= 24 && mi <= 59 && sec < 61)) return null;
    const cd = civilFromDays(daysFromCivil(y, mo, d));
    if (cd[1] !== mo || cd[2] !== d) return null;
    let off = 0;
    const z = m[7];
    if (z && z !== "Z" && z !== "z") {
      const sign = z[0] === "-" ? -1 : 1;
      const digits = z.slice(1).replace(":", "");
      off = sign * (parseInt(digits.slice(0, 2), 10) * 3600 + parseInt(digits.slice(2), 10) * 60);
    }
    return daysFromCivil(y, mo, d) * 86400 + hh * 3600 + mi * 60 + sec - off;
  }
  function haversine(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
    const s1 = Math.sin(dp / 2), s2 = Math.sin(dl / 2);
    const a = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
    return 2 * EARTH_R * Math.asin(Math.sqrt(Math.min(1, a)));
  }
  function projectLocal(lat, lon, lat0, lon0) {
    const k = Math.PI / 180 * EARTH_R;
    return [(lon - lon0) * k * Math.cos(lat0 * Math.PI / 180), (lat - lat0) * k];
  }
  function sum(xs) { let s = 0; for (const x of xs) s += x; return s; }
  function mean(xs) { return xs.length ? sum(xs) / xs.length : null; }
  function sd(xs) {
    const n = xs.length;
    if (n < 2) return null;
    const m = sum(xs) / n;
    let s = 0;
    for (const x of xs) s += (x - m) * (x - m);
    return Math.sqrt(s / (n - 1));
  }

  // ------------------------------------------------------------------ FIT
  const FIT_EPOCH = 631065600;
  const SEMI = 180.0 / 2147483648.0;
  const MAX_ACTIVITY_BYTES = 50 * 1024 * 1024;
  // base type (low 5 bits) -> [kind, size, invalid]
  const BASE = {
    0: ["u8", 1, 0xFF], 1: ["i8", 1, 0x7F], 2: ["u8", 1, 0xFF], 3: ["i16", 2, 0x7FFF], 4: ["u16", 2, 0xFFFF],
    5: ["i32", 4, 0x7FFFFFFF], 6: ["u32", 4, 0xFFFFFFFF], 7: [null, 1, null], 8: ["f32", 4, null],
    9: ["f64", 8, null], 10: ["u8", 1, 0], 11: ["u16", 2, 0], 12: ["u32", 4, 0], 13: [null, 1, null],
    14: [null, 8, null], 15: [null, 8, null], 16: [null, 8, null],
  };
  const CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
  const SPORTS = { 1: "run", 2: "ride", 11: "run" };
  function crc16(bytes, start, end, crc) {
    crc = crc || 0;
    for (let i = start; i < end; i++) {
      const b = bytes[i];
      let tmp = CRC_TABLE[crc & 0xF];
      crc = (crc >> 4) & 0x0FFF;
      crc = crc ^ tmp ^ CRC_TABLE[b & 0xF];
      tmp = CRC_TABLE[crc & 0xF];
      crc = (crc >> 4) & 0x0FFF;
      crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xF];
    }
    return crc;
  }
  function readValue(dv, pos, size, bt, little) {
    const spec = BASE[bt & 0x1F] || [null, 1, null];
    const [kind, bsize, invalid] = spec;
    if (kind === null || size < bsize || size % bsize) return null;
    const count = size / bsize;
    const out = [];
    for (let k = 0; k < count; k++) {
      const p = pos + k * bsize;
      let v;
      switch (kind) {
        case "u8": v = dv.getUint8(p); break;
        case "i8": v = dv.getInt8(p); break;
        case "u16": v = dv.getUint16(p, little); break;
        case "i16": v = dv.getInt16(p, little); break;
        case "u32": v = dv.getUint32(p, little); break;
        case "i32": v = dv.getInt32(p, little); break;
        case "f32": v = dv.getFloat32(p, little); break;
        default: v = dv.getFloat64(p, little);
      }
      if (kind === "f32" || kind === "f64") out.push(Number.isFinite(v) ? v : null);
      else out.push(v === invalid ? null : v);
    }
    return count === 1 ? out[0] : out;
  }
  function readData(buf, dv, pos, end, d) {
    let size = d.dev;
    for (const f of d.fields) size += f[1];
    if (pos + size > end) throw err("fit_truncated", "Data message runs past the end of the data.");
    const fields = new Map();
    for (const [num, fsize, bt] of d.fields) {
      fields.set(num, readValue(dv, pos, fsize, bt, d.little));
      pos += fsize;
    }
    pos += d.dev;
    return [fields, pos];
  }
  const MAX_MESSAGES = 3000000; // a day-long 1 s recording has about 90,000; caps hostile files of tiny messages
  function decodeOne(buf, dv, start, warnings) {
    const n = buf.length;
    if (n - start < 12) throw err("fit_header", "File is too short to be a FIT file.");
    const hsize = buf[start];
    if ((hsize !== 12 && hsize !== 14) || n - start < hsize) throw err("fit_header", "Not a FIT file (bad header size).");
    if (buf[start + 8] !== 0x2E || buf[start + 9] !== 0x46 || buf[start + 10] !== 0x49 || buf[start + 11] !== 0x54)
      throw err("fit_header", "Not a FIT file (missing .FIT signature).");
    const dataSize = dv.getUint32(start + 4, true);
    if (hsize === 14) {
      const hcrc = dv.getUint16(start + 12, true);
      if (hcrc !== 0 && hcrc !== crc16(buf, start, start + 12)) warnings.push("header CRC mismatch");
    }
    let pos = start + hsize;
    let end = pos + dataSize;
    if (end > n) { warnings.push("file is truncated; decoded what was present"); end = n; }
    const defs = new Map();
    let lastTs = null;
    const msgs = [];
    while (pos < end) {
      const h = buf[pos]; pos += 1;
      if (h & 0x80) {
        const local = (h >> 5) & 0x03, off = h & 0x1F;
        if (lastTs === null) throw err("fit_def", "Compressed timestamp before any full timestamp.");
        let ts = (lastTs - (lastTs % 32)) + off;
        if (off < (lastTs % 32)) ts += 0x20;
        lastTs = ts;
        const d = defs.get(local);
        if (!d) throw err("fit_def", "Data message uses an undefined local message type.");
        const r = readData(buf, dv, pos, end, d);
        pos = r[1];
        r[0].set(253, ts);
        msgs.push([d.global, r[0]]);
        if (msgs.length > MAX_MESSAGES) throw err("size", "The FIT file has more messages than any real activity (over 3 million).");
        continue;
      }
      const local = h & 0x0F;
      if (h & 0x40) {
        if (pos + 5 > end) throw err("fit_truncated", "Definition message runs past the end of the data.");
        const little = buf[pos + 1] === 0;
        const glob = dv.getUint16(pos + 2, little);
        const nf = buf[pos + 4];
        pos += 5;
        if (pos + nf * 3 > end) throw err("fit_truncated", "Definition message runs past the end of the data.");
        const fdefs = [];
        for (let k = 0; k < nf; k++) { fdefs.push([buf[pos], buf[pos + 1], buf[pos + 2]]); pos += 3; }
        let devSize = 0;
        if (h & 0x20) {
          if (pos + 1 > end) throw err("fit_truncated", "Developer field count missing.");
          const nd = buf[pos]; pos += 1;
          if (pos + nd * 3 > end) throw err("fit_truncated", "Developer field definitions run past the end.");
          for (let k = 0; k < nd; k++) { devSize += buf[pos + 1]; pos += 3; }
        }
        defs.set(local, { global: glob, little, fields: fdefs, dev: devSize });
        continue;
      }
      const d = defs.get(local);
      if (!d) throw err("fit_def", "Data message uses an undefined local message type.");
      const r = readData(buf, dv, pos, end, d);
      pos = r[1];
      const ts = r[0].get(253);
      if (ts !== undefined && ts !== null) lastTs = ts;
      msgs.push([d.global, r[0]]);
      if (msgs.length > MAX_MESSAGES) throw err("size", "The FIT file has more messages than any real activity (over 3 million).");
    }
    if (end + 2 <= n && end === start + hsize + dataSize) {
      const fcrc = dv.getUint16(end, true);
      if (fcrc !== crc16(buf, start, end)) warnings.push("file CRC mismatch");
      end += 2;
    }
    return [msgs, end];
  }
  const scal = (v, scale, offset) => (v === null || v === undefined || Array.isArray(v)) ? null : v / scale - (offset || 0);
  const fts = (v) => (v === null || v === undefined || Array.isArray(v)) ? null : v + FIT_EPOCH;
  function newActivity(source, name, sport) {
    return { source, name: name || "", sport: sport || "other", start: null, t: [], lat: [], lon: [], ele: [], hr: [],
      cad: [], pwr: [], dist: [], laps: [], session: null, pauses: [], rr: [], warnings: [] };
  }
  const CH = ["t", "lat", "lon", "ele", "hr", "cad", "pwr", "dist"];
  function decodeFit(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (buf.length > MAX_ACTIVITY_BYTES) throw err("size", "FIT file is over the 50 MB limit.");
    if (buf.length < 12) throw err("fit_header", "File is too short to be a FIT file.");
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const warnings = [];
    let msgs = [];
    let pos = 0;
    while (pos < buf.length) {
      if (buf.length - pos < 12) break;
      const r = decodeOne(buf, dv, pos, warnings);
      msgs = msgs.concat(r[0]);
      pos = r[1];
      if (pos < buf.length && (buf.length - pos < 12 || (buf[pos] !== 12 && buf[pos] !== 14))) break;
    }
    const act = newActivity("fit");
    act.warnings = warnings;
    let sport = null, timerStop = null;
    for (const [glob, f] of msgs) {
      const g = (k) => { const v = f.get(k); return v === undefined ? null : v; };
      if (glob === 0) {
        const ftype = g(0);
        if (ftype !== null && ftype !== 4) throw err("fit_type", "This FIT file is not an activity (file type " + ftype + ").");
      } else if (glob === 20) {
        const t = fts(g(253));
        if (t === null) continue;
        let lat = g(0), lon = g(1);
        lat = (lat === null || Array.isArray(lat)) ? null : lat * SEMI;
        lon = (lon === null || Array.isArray(lon)) ? null : lon * SEMI;
        if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) { lat = null; lon = null; }
        let ele = scal(g(78), 5.0, 500.0);
        if (ele === null) ele = scal(g(2), 5.0, 500.0);
        const row = [t, lat, lon, ele, scal(g(3), 1), scal(g(4), 1), scal(g(7), 1), scal(g(5), 100.0)];
        const n = act.t.length;
        if (n && t === act.t[n - 1]) {
          for (let k = 1; k < CH.length; k++) if (act[CH[k]][n - 1] === null && row[k] !== null) act[CH[k]][n - 1] = row[k];
          continue;
        }
        if (n && t < act.t[n - 1]) { warnings.push("record out of time order skipped"); continue; }
        for (let k = 0; k < CH.length; k++) act[CH[k]].push(row[k]);
      } else if (glob === 19) {
        act.laps.push({ start: fts(g(2)), elapsed: scal(g(7), 1000.0), timer: scal(g(8), 1000.0),
          distance: scal(g(9), 100.0), avg_hr: scal(g(15), 1), max_hr: scal(g(16), 1) });
      } else if (glob === 18) {
        if (act.session === null) {
          const sp = g(5);
          sport = sp !== null ? (SPORTS[sp] || "other") : null;
          act.session = { start: fts(g(2)), elapsed: scal(g(7), 1000.0), timer: scal(g(8), 1000.0),
            distance: scal(g(9), 100.0), avg_hr: scal(g(16), 1), max_hr: scal(g(17), 1),
            ascent: scal(g(22), 1), avg_power: scal(g(20), 1), sport };
        }
      } else if (glob === 21) {
        if (g(0) === 0) {
          const t = fts(g(253)), et = g(1);
          if (t === null) continue;
          if ((et === 1 || et === 4) && timerStop === null) timerStop = t;
          else if (et === 0 && timerStop !== null) {
            if (t > timerStop) act.pauses.push([timerStop, t]);
            timerStop = null;
          }
        }
      } else if (glob === 78) {
        const v = g(0);
        const vals = Array.isArray(v) ? v : [v];
        for (const x of vals) if (x !== null) act.rr.push(x);
      }
    }
    if (act.t.length < 2 && !act.rr.length) throw err("nopoints", "The FIT file has no timed record messages.");
    act.sport = sport || "other";
    act.start = act.t.length ? act.t[0] : (act.session || {}).start || null;
    return act;
  }

  // ------------------------------------------------------------------ GPX / TCX (DOM-like trees)
  const DTD = /<!DOCTYPE|<!ENTITY/i;
  function xmlText(bytes) {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (raw.length > MAX_ACTIVITY_BYTES) throw err("size", "File is over the 50 MB limit.");
    if ((raw[0] === 0xFF && raw[1] === 0xFE) || (raw[0] === 0xFE && raw[1] === 0xFF))
      throw err("encoding", "UTF-16 files are not supported; save the file as UTF-8.");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
    catch (e) { throw err("encoding", "The file is not valid UTF-8 text."); }
    return checkXml(text);
  }
  function checkXml(text) {
    if (text.length > MAX_ACTIVITY_BYTES) throw err("size", "File is over the 50 MB limit.");
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (DTD.test(text)) throw err("doctype", "The file declares a DOCTYPE or ENTITY. Refused for safety.");
    return text;
  }
  const kids = (el, name) => Array.from(el.children).filter((c) => c.localName === name);
  const kid = (el, name) => { for (const c of el.children) if (c.localName === name) return c; return null; };
  const txt = (el) => (el ? el.textContent : "");
  function firstDesc(el, names) {
    const stack = Array.from(el.children).reverse();
    while (stack.length) {
      const d = stack.pop();
      if (names.includes(d.localName)) return d;
      const ch = Array.from(d.children);
      for (let k = ch.length - 1; k >= 0; k--) stack.push(ch[k]);
    }
    return null;
  }
  function sportOf(s) {
    s = (s || "").trim().toLowerCase();
    if (s.includes("run") || s.includes("walk") || s.includes("hik")) return "run";
    if (s.includes("bik") || s.includes("cycl") || s.includes("ride")) return "ride";
    return "other";
  }
  function pushPoint(act, st, t, lat, lon, ele, hr, cad, pwr, dist) {
    if (t === null) { st.untimed++; return; }
    const n = act.t.length;
    if (n && t < act.t[n - 1]) { st.back++; return; }
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) { lat = null; lon = null; }
    const row = [t, lat, lon, ele, hr, cad, pwr, dist];
    for (let k = 0; k < CH.length; k++) act[CH[k]].push(row[k]);
  }
  function finishAct(act, st) {
    if (st.untimed) act.warnings.push("points without a time were skipped");
    if (st.back) act.warnings.push("points out of time order were skipped");
    if (act.t.length < 2) throw err("notimes", "Fewer than two points with a valid time; nothing to analyse.");
    act.start = act.t[0];
    return act;
  }
  const numOf = (el) => (el ? num(txt(el)) : null);
  function parseGpxDoc(root) {
    if (!root || root.localName !== "gpx") throw err("notgpx", "Not a GPX file (root element is not <gpx>).");
    let name = "", typ = "";
    const md = kid(root, "metadata");
    if (md && kid(md, "name")) name = txt(kid(md, "name")).trim();
    const act = newActivity("gpx");
    const st = { untimed: 0, back: 0 };
    for (const trk of kids(root, "trk")) {
      if (kid(trk, "name") && !name) name = txt(kid(trk, "name")).trim();
      if (kid(trk, "type") && !typ) typ = txt(kid(trk, "type"));
      for (const seg of kids(trk, "trkseg")) {
        for (const p of kids(seg, "trkpt")) {
          const ext = kid(p, "extensions");
          let hr = null, cad = null, pwr = null;
          if (ext) {
            hr = numOf(firstDesc(ext, ["hr", "heartrate"]));
            cad = numOf(firstDesc(ext, ["cad", "cadence"]));
            pwr = numOf(firstDesc(ext, ["power", "watts"]));
          }
          const tm = kid(p, "time");
          pushPoint(act, st, tm ? parseTime(txt(tm)) : null, num(p.getAttribute("lat")), num(p.getAttribute("lon")),
            numOf(kid(p, "ele")), hr, cad, pwr, null);
        }
      }
    }
    act.name = name.slice(0, 200);
    act.sport = sportOf(typ);
    return [finishAct(act, st)];
  }
  function parseTcxDoc(root) {
    if (!root || root.localName !== "TrainingCenterDatabase") throw err("nottcx", "Not a TCX file (root element is not <TrainingCenterDatabase>).");
    const out = [];
    const acts = kid(root, "Activities");
    for (const a of (acts ? kids(acts, "Activity") : [])) {
      const act = newActivity("tcx", "", sportOf(a.getAttribute("Sport") || ""));
      const st = { untimed: 0, back: 0 };
      const notes = kid(a, "Notes");
      if (notes) act.name = txt(notes).trim().slice(0, 200);
      for (const lap of kids(a, "Lap")) {
        const lv = (name, sub) => { let e = kid(lap, name); if (e && sub) e = kid(e, sub); return numOf(e); };
        const tt = lv("TotalTimeSeconds");
        act.laps.push({ start: parseTime(lap.getAttribute("StartTime")), elapsed: tt, timer: tt,
          distance: lv("DistanceMeters"), avg_hr: lv("AverageHeartRateBpm", "Value"), max_hr: lv("MaximumHeartRateBpm", "Value") });
        for (const trk of kids(lap, "Track")) {
          for (const p of kids(trk, "Trackpoint")) {
            const pos = kid(p, "Position");
            let lat = null, lon = null;
            if (pos) { lat = numOf(kid(pos, "LatitudeDegrees")); lon = numOf(kid(pos, "LongitudeDegrees")); }
            const pv = (name, sub) => { let e = kid(p, name); if (e && sub) e = kid(e, sub); return numOf(e); };
            let cad = pv("Cadence"), pwr = null;
            const ext = kid(p, "Extensions");
            if (ext) {
              pwr = numOf(firstDesc(ext, ["Watts"]));
              if (cad === null) cad = numOf(firstDesc(ext, ["RunCadence"]));
            }
            const tm = kid(p, "Time");
            pushPoint(act, st, tm ? parseTime(txt(tm)) : null, lat, lon, pv("AltitudeMeters"), pv("HeartRateBpm", "Value"),
              cad, pwr, pv("DistanceMeters"));
          }
        }
      }
      out.push(finishAct(act, st));
    }
    if (!out.length) throw err("notimes", "The TCX file has no activities.");
    return out;
  }

  // ------------------------------------------------------------------ analysis
  const DEFAULTS = {
    max_hr: 190.0, rest_hr: 50.0, zone_method: "hrr", trimp_sex: "male", load_method: "banister", units: "km",
    run_stop: 0.5, run_go: 0.8, ride_stop: 1.0, ride_go: 1.5, min_stop: 5.0, ele_window: 5, ele_hyst: 3.0,
    hr_gap: 60.0, run_vmax: 12.0, ride_vmax: 30.0, fit_tau: 42.0, fat_tau: 7.0,
    sleep_base: 8.0, sleep_debt_share: 0.1, sleep_load_per100: 0.0,
    weight_kg: 70.0, age: 40.0, ftp: 0.0, threshold_speed: 0.0, vt1_hr: 0.0, vt2_hr: 0.0,
    wake_min: 390.0, sleep_latency: 15.0,
  };
  const TARGETS = [["400 m", 400.0], ["1 km", 1000.0], ["1 mile", 1609.344], ["5 km", 5000.0], ["10 km", 10000.0], ["Half marathon", 21097.5]];
  const MEANMAX = [5, 30, 60, 300, 1200, 3600];
  const TRIMP_COEF = { male: [0.64, 1.92], female: [0.86, 1.67] };
  function settingsWith(s) {
    const out = Object.assign({}, DEFAULTS);
    if (s) for (const k of Object.keys(s)) if (s[k] !== null && s[k] !== undefined) out[k] = s[k];
    return out;
  }
  function cumdist(act) {
    const lat = act.lat, lon = act.lon, dist = act.dist, n = act.t.length;
    let npos = 0;
    for (const x of lat) if (x !== null) npos++;
    const d = new Array(n).fill(0);
    if (npos >= 2) {
      let acc = 0, last = null;
      for (let i = 0; i < n; i++) {
        if (lat[i] !== null && lon[i] !== null) {
          if (last) acc += haversine(last[0], last[1], lat[i], lon[i]);
          last = [lat[i], lon[i]];
        }
        d[i] = acc;
      }
      return d;
    }
    let nd = 0;
    for (const x of dist) if (x !== null) nd++;
    if (nd >= 2) {
      let base = null, prev = 0;
      for (let i = 0; i < n; i++) {
        if (dist[i] !== null) {
          if (base === null) base = dist[i];
          prev = Math.max(prev, dist[i] - base);
        }
        d[i] = prev;
      }
    }
    return d;
  }
  function movingMask(t, d, sport, s, pauses) {
    const n = t.length;
    const stop = sport === "ride" ? s.ride_stop : s.run_stop;
    const go = sport === "ride" ? s.ride_go : s.run_go;
    const mov = new Array(n).fill(false);
    let state = null;
    for (let i = 1; i < n; i++) {
      const dt = t[i] - t[i - 1];
      const v = dt > 0 ? (d[i] - d[i - 1]) / dt : 0;
      if (state === null) state = v >= stop;
      else if (state && v < stop) state = false;
      else if (!state && v >= go) state = true;
      mov[i] = state && dt > 0;
    }
    let i = 1;
    while (i < n) {
      if (!mov[i]) {
        let j = i, dur = 0;
        while (j < n && !mov[j]) { dur += Math.max(0, t[j] - t[j - 1]); j++; }
        if (dur < s.min_stop) for (let k = i; k < j; k++) if (t[k] - t[k - 1] > 0) mov[k] = true;
        i = j;
      } else i++;
    }
    for (const [a, b] of (pauses || [])) {
      for (let k = 1; k < n; k++) {
        const mid = (t[k] + t[k - 1]) / 2;
        if (a <= mid && mid <= b) mov[k] = false;
      }
    }
    return mov;
  }
  function smooth(vals, window) {
    let w = Math.trunc(window);
    if (w < 1) w = 1;
    if (w % 2 === 0) w += 1;
    const h = Math.floor(w / 2), n = vals.length;
    const c = new Array(n + 1).fill(0);
    for (let i = 0; i < n; i++) c[i + 1] = c[i] + vals[i];
    const out = [];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - h), hi = Math.min(n, i + h + 1);
      out.push((c[hi] - c[lo]) / (hi - lo));
    }
    return out;
  }
  function zigzag(vals, h) {
    let gain = 0, loss = 0;
    if (!vals.length) return [0, 0];
    let lo = vals[0], hi = vals[0], dir = 0, anchor = vals[0], cand = vals[0];
    for (let k = 1; k < vals.length; k++) {
      const x = vals[k];
      if (dir === 0) {
        if (x < lo) lo = x;
        if (x > hi) hi = x;
        if (x - lo >= h && x - lo >= hi - x) { dir = 1; anchor = lo; cand = x; }
        else if (hi - x >= h) { dir = -1; anchor = hi; cand = x; }
      } else if (dir === 1) {
        if (x > cand) cand = x;
        else if (cand - x >= h) { gain += cand - anchor; anchor = cand; cand = x; dir = -1; }
      } else {
        if (x < cand) cand = x;
        else if (x - cand >= h) { loss += anchor - cand; anchor = cand; cand = x; dir = 1; }
      }
    }
    if (dir === 1) gain += cand - anchor;
    else if (dir === -1) loss += anchor - cand;
    return [gain, loss];
  }
  function elevation(ele, s) {
    const vals = ele.filter((e) => e !== null);
    if (vals.length < 2) return null;
    let raw = 0;
    for (let i = 1; i < vals.length; i++) if (vals[i] > vals[i - 1]) raw += vals[i] - vals[i - 1];
    const sm = smooth(vals, s.ele_window);
    const [gain, loss] = zigzag(sm, s.ele_hyst);
    let mn = Infinity, mx = -Infinity;
    for (const x of sm) { if (x < mn) mn = x; if (x > mx) mx = x; }
    return { raw_gain: raw, gain, loss, min: mn, max: mx };
  }
  function filledSmoothed(ele, s) {
    const idx = [];
    for (let i = 0; i < ele.length; i++) if (ele[i] !== null) idx.push(i);
    if (idx.length < 2) return null;
    const sm = smooth(idx.map((i) => ele[i]), s.ele_window);
    const out = new Array(ele.length).fill(null);
    idx.forEach((i, k) => { out[i] = sm[k]; });
    let prev = sm[0];
    for (let i = 0; i < out.length; i++) { if (out[i] === null) out[i] = prev; else prev = out[i]; }
    return out;
  }
  function bisectLeft(a, x) {
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function interpAt(d, ys, x) {
    const n = d.length, j = bisectLeft(d, x);
    if (j <= 0) return ys[0];
    if (j >= n) return ys[n - 1];
    const f = (x - d[j - 1]) / (d[j] - d[j - 1]);
    return ys[j - 1] + f * (ys[j] - ys[j - 1]);
  }
  function splits(t, d, mov, ez, hr, unitM, s) {
    const total = d.length ? d[d.length - 1] : 0;
    if (total <= 0) return [];
    const bounds = [];
    let k = 1;
    while (k * unitM <= total) { bounds.push(k * unitM); k++; }
    const last = bounds.length ? bounds[bounds.length - 1] : 0;
    if (total - last >= 10.0) bounds.push(total);
    const out = [];
    let a = 0;
    const n = t.length;
    for (const b of bounds) {
      const ta = interpAt(d, t, a), tb = interpAt(d, t, b);
      let moving = 0, wsum = 0, hsum = 0;
      const j0 = Math.max(1, bisectLeft(d, a));
      for (let i = j0; i < n; i++) {
        if (d[i - 1] >= b) break;
        const dd = d[i] - d[i - 1];
        if (dd <= 0) continue;
        const ov = Math.min(b, d[i]) - Math.max(a, d[i - 1]);
        if (ov <= 0) continue;
        const dt = t[i] - t[i - 1], frac = ov / dd;
        if (mov[i]) moving += dt * frac;
        if (hr[i - 1] !== null && dt > 0 && dt <= s.hr_gap) { wsum += dt * frac; hsum += dt * frac * hr[i - 1]; }
      }
      out.push({ index: out.length + 1, distance: b - a, elapsed: tb - ta, moving,
        ele_delta: ez ? interpAt(d, ez, b) - interpAt(d, ez, a) : null, avg_hr: wsum > 0 ? hsum / wsum : null });
      a = b;
    }
    return out;
  }
  function badPrefix(t, d, vmax) {
    const n = t.length, b = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const dt = t[i] - t[i - 1], dd = d[i] - d[i - 1];
      const bad = (dd > 0 && dt <= 0) || (dt > 0 && dd / dt > vmax);
      b[i] = b[i - 1] + (bad ? 1 : 0);
    }
    return b;
  }
  function fastest(t, d, target, bad) {
    const n = t.length;
    let best = null, bestStart = null, j = 0;
    for (let i = 0; i < n; i++) {
      while (j < n && d[j] - d[i] < target) j++;
      if (j >= n) break;
      if (bad[j] - bad[i] > 0) continue;
      const x = d[i] + target, f = (x - d[j - 1]) / (d[j] - d[j - 1]);
      const te = t[j - 1] + f * (t[j] - t[j - 1]), el = te - t[i];
      if (best === null || el < best) { best = el; bestStart = t[i]; }
    }
    let i = 0;
    for (let jj = 0; jj < n; jj++) {
      while (i + 1 <= jj && d[jj] - d[i + 1] >= target) i++;
      if (d[jj] - d[i] < target || i + 1 > jj) continue;
      if (bad[jj] - bad[i] > 0) continue;
      const x = d[jj] - target, f = (x - d[i]) / (d[i + 1] - d[i]);
      const ts = t[i] + f * (t[i + 1] - t[i]), el = t[jj] - ts;
      if (best === null || el < best) { best = el; bestStart = ts; }
    }
    if (best === null) return null;
    return { time: best, start: bestStart - t[0] };
  }
  function zoneBounds(s) {
    const mx = s.max_hr, rest = s.rest_hr, fr = [0.5, 0.6, 0.7, 0.8, 0.9];
    if (s.zone_method === "max") return fr.map((f) => f * mx);
    return fr.map((f) => rest + f * (mx - rest));
  }
  function heart(t, hr, s) {
    const bounds = zoneBounds(s);
    const [a, b] = TRIMP_COEF[s.trimp_sex] || TRIMP_COEF.male;
    const mx = s.max_hr, rest = s.rest_hr;
    const zones = [0, 0, 0, 0, 0, 0];
    let tsum = 0, hsum = 0, trimp = 0, edw = 0;
    for (let i = 1; i < t.length; i++) {
      const dt = t[i] - t[i - 1], h = hr[i - 1];
      if (h === null || dt <= 0 || dt > s.hr_gap) continue;
      tsum += dt; hsum += h * dt;
      let z = 0;
      for (const bd of bounds) if (h >= bd) z++;
      zones[z] += dt;
      let x = (h - rest) / (mx - rest);
      x = x < 0 ? 0 : (x > 1 ? 1 : x);
      trimp += dt / 60.0 * x * a * Math.exp(b * x);
      const p = h / mx;
      const w = p < 0.5 ? 0 : p < 0.6 ? 1 : p < 0.7 ? 2 : p < 0.8 ? 3 : p < 0.9 ? 4 : 5;
      edw += dt / 60.0 * w;
    }
    if (tsum <= 0) return null;
    let hmax = -Infinity;
    for (const h of hr) if (h !== null && h > hmax) hmax = h;
    return { avg: hsum / tsum, max: hmax, time: tsum, zones, bounds, trimp, edwards: edw };
  }
  function power(t, pwr, s) {
    let cntp = 0;
    for (const p of pwr) if (p !== null) cntp++;
    if (cntp < 2) return null;
    const t0 = t[0], T = Math.floor(t[t.length - 1] - t0), n = t.length;
    const grid = [];
    let k = 0;
    for (let sec = 0; sec <= T; sec++) {
      while (k + 1 < n && t[k + 1] - t0 <= sec) k++;
      const p = pwr[k];
      grid.push(p !== null && sec - (t[k] - t0) <= s.hr_gap ? p : 0);
    }
    const c = [0];
    for (const p of grid) c.push(c[c.length - 1] + p);
    const m = grid.length;
    const avg = c[m] / m;
    let weighted = null;
    if (m >= 30) {
      let acc = 0, cnt = 0;
      for (let kk = 29; kk < m; kk++) { const r = (c[kk + 1] - c[kk - 29]) / 30.0; acc += r * r * r * r; cnt++; }
      weighted = Math.pow(acc / cnt, 0.25);
    }
    const mm = {};
    for (const w of MEANMAX) {
      if (w <= m) {
        let best = 0;
        for (let kk = 0; kk <= m - w; kk++) { const v = (c[kk + w] - c[kk]) / w; if (v > best) best = v; }
        mm[String(w)] = best;
      }
    }
    let pmax = -Infinity;
    for (const p of pwr) if (p !== null && p > pmax) pmax = p;
    return { avg, weighted, max: pmax, meanmax: mm };
  }
  function minettiCost(i) {
    if (i < -0.45) i = -0.45;
    if (i > 0.45) i = 0.45;
    return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
  }
  function gradeAdjusted(t, d, mov, ez, chunk) {
    chunk = chunk || 20.0;
    if (!ez) return null;
    const n = t.length, c0 = minettiCost(0.0);
    let eq = 0, mt = 0, s = 0;
    for (let i = 1; i < n; i++) {
      if (d[i] - d[s] >= chunk || i === n - 1) {
        const span = d[i] - d[s];
        const grade = span >= chunk ? (ez[i] - ez[s]) / span : 0.0;
        const ratio = minettiCost(grade) / c0;
        for (let k = s + 1; k <= i; k++) if (mov[k]) { mt += t[k] - t[k - 1]; eq += (d[k] - d[k - 1]) * ratio; }
        s = i;
      }
    }
    if (mt <= 0 || eq <= 0) return null;
    return { flat_distance: eq, speed: eq / mt };
  }
  function interpTime(t, d, x) {
    const n = t.length, j = bisectLeft(t, x);
    if (j <= 0) return d[0];
    if (j >= n) return d[n - 1];
    if (t[j] === t[j - 1]) return d[j];
    const f = (x - t[j - 1]) / (t[j] - t[j - 1]);
    return d[j - 1] + f * (d[j] - d[j - 1]);
  }
  function lapTable(t, d, hr, laps, s) {
    let starts = laps.filter((x) => x.start !== null && x.start !== undefined).map((x) => x.start).sort((a, b) => a - b);
    if (!starts.length || !t.length) return [];
    starts = starts.map((a) => Math.max(t[0], a));
    const out = [];
    for (let k = 0; k < starts.length; k++) {
      const a = starts[k], b = k + 1 < starts.length ? starts[k + 1] : t[t.length - 1];
      if (b <= a) continue;
      const da = interpTime(t, d, a), db = interpTime(t, d, b);
      let wsum = 0, hsum = 0;
      for (let i = 1; i < t.length; i++) {
        const dt = t[i] - t[i - 1];
        if (t[i - 1] >= a && t[i] <= b && hr[i - 1] !== null && dt > 0 && dt <= s.hr_gap) { wsum += dt; hsum += dt * hr[i - 1]; }
      }
      out.push({ index: out.length + 1, distance: db - da, elapsed: b - a, avg_hr: wsum > 0 ? hsum / wsum : null });
    }
    return out;
  }
  function maxSpeed(t, d, bad) {
    let best = 0;
    for (let i = 1; i < t.length; i++) {
      const dt = t[i] - t[i - 1];
      if (dt > 0 && bad[i] === bad[i - 1]) { const v = (d[i] - d[i - 1]) / dt; if (v > best) best = v; }
    }
    return best;
  }
  function analyzeSummary(summ, settings, rpe) {
    const s = settingsWith(settings);
    const dur = summ.duration || 0, dist = summ.distance || 0;
    let load = SB.summaryTrimp(summ.avg_hr === undefined ? null : summ.avg_hr, dur / 60.0, s);
    let src = load !== null ? "approx" : null;
    if (load === null && rpe !== null && rpe !== undefined) { load = Number(rpe) * dur / 60.0; src = "rpe"; }
    let kc = summ.kcal === undefined ? null : summ.kcal;
    if (kc === null) kc = SB.calories([], [], summ.sport || "other", dur, dur ? dist / dur : 0, s).kcal;
    return { sport: summ.sport || "other", distance: dist, elapsed: dur, moving: dur, gain: summ.gain || 0,
      avg_hr: summ.avg_hr === undefined ? null : summ.avg_hr, max_hr: summ.max_hr === undefined ? null : summ.max_hr,
      load, load_source: src, kcal: kc };
  }
  function analyze(act, settings, rpe) {
    const s = settingsWith(settings);
    const t = act.t, n = t.length, d = cumdist(act), sport = act.sport || "other";
    const mov = movingMask(t, d, sport, s, act.pauses || []);
    let moving = 0;
    for (let i = 1; i < n; i++) if (mov[i]) moving += t[i] - t[i - 1];
    const elapsed = n ? t[n - 1] - t[0] : 0, dist = n ? d[n - 1] : 0;
    const ez = filledSmoothed(act.ele, s);
    const unitM = s.units === "mi" ? 1609.344 : 1000.0;
    const bad = badPrefix(t, d, sport === "ride" ? s.ride_vmax : s.run_vmax);
    const best = TARGETS.map(([label, D]) => {
      const r = dist >= D ? fastest(t, d, D, bad) : null;
      return { label, distance: D, time: r ? r.time : null, start: r ? r.start : null };
    });
    const hrs = heart(t, act.hr, s);
    const lu = SB.luciaTrimp(t, act.hr, s.vt1_hr, s.vt2_hr, s);
    let load = null, loadSource = null;
    if (hrs) {
      if (s.load_method === "lucia" && lu !== null) { load = lu; loadSource = "lucia"; }
      else { load = s.load_method === "edwards" ? hrs.edwards : hrs.trimp; loadSource = s.load_method === "edwards" ? "edwards" : "banister"; }
    }
    else if (rpe !== null && rpe !== undefined) { load = Number(rpe) * moving / 60.0; loadSource = "rpe"; }
    const session = act.session || {};
    const pw = power(t, act.pwr, s);
    const speed = moving > 0 ? dist / moving : null;
    return {
      calories: SB.calories(t, act.hr, sport, moving, speed || 0, s),
      power_zones: pw ? SB.powerZoneTime(t, act.pwr, s.ftp, s) : null,
      power_load: pw ? SB.powerLoad(pw.weighted, elapsed, s.ftp) : null,
      pace_zones: sport === "run" ? SB.paceZoneTime(t, d, mov, s.threshold_speed) : null,
      lucia: lu, max_speed: maxSpeed(t, d, bad), lap_table: lapTable(t, d, act.hr, act.laps || [], s),
      sport, start: act.start, points: n, distance: dist, elapsed, moving,
      timer: session.timer === undefined ? null : session.timer,
      speed,
      elevation: elevation(act.ele, s),
      splits: splits(t, d, mov, ez, act.hr, unitM, s),
      fastest: best, hr: hrs, load, load_source: loadSource,
      power: pw,
      gap: sport === "run" ? gradeAdjusted(t, d, mov, ez) : null,
      laps: (act.laps || []).length,
      _d: d, _mov: mov, _ez: ez,
    };
  }

  // ------------------------------------------------------------------ load
  function loadSeries(daily, startDay, endDay, fitTau, fatTau) {
    fitTau = fitTau || 42.0; fatTau = fatTau || 7.0;
    const out = { day: [], load: [], fitness: [], fatigue: [], form: [], ratio: [] };
    if (endDay < startDay) return out;
    const kf = 1.0 - Math.exp(-1.0 / fitTau), kd = 1.0 - Math.exp(-1.0 / fatTau);
    let f = 0, g = 0;
    const get = (z) => (daily instanceof Map ? daily.get(z) : daily[z]);
    for (let z = startDay; z <= endDay; z++) {
      const L = Number(get(z) || 0);
      out.form.push(f - g);
      f = f + (L - f) * kf;
      g = g + (L - g) * kd;
      out.day.push(z); out.load.push(L); out.fitness.push(f); out.fatigue.push(g);
      const k = out.load.length - 1;
      if (k >= 27) {
        let a = 0, u = 0;
        for (let q = k - 6; q <= k; q++) a += out.load[q];
        for (let q = k - 27; q < k - 6; q++) u += out.load[q];
        const acute = a / 7.0, usual = u / 21.0;
        out.ratio.push(usual > 0 ? acute / usual : null);
      } else out.ratio.push(null);
    }
    return out;
  }
  function dailyLoads(items) {
    const out = new Map();
    for (const [z, L] of items) { if (L === null || L === undefined) continue; out.set(z, (out.get(z) || 0) + L); }
    return out;
  }

  // ------------------------------------------------------------------ recovery
  const MAX_HEALTH_BYTES = 200 * 1024 * 1024, MAX_ROWS = 50000;
  const T_SDNN = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";
  const T_RMSSD = "HKQuantityTypeIdentifierHeartRateVariabilityRMSSD";
  const T_RHR = "HKQuantityTypeIdentifierRestingHeartRate";
  const T_SLEEP = "HKCategoryTypeIdentifierSleepAnalysis";
  const T_STEPS = "HKQuantityTypeIdentifierStepCount", T_ENERGY = "HKQuantityTypeIdentifierActiveEnergyBurned";
  const T_HR = "HKQuantityTypeIdentifierHeartRate", T_RESP = "HKQuantityTypeIdentifierRespiratoryRate";
  const T_SPO2 = "HKQuantityTypeIdentifierOxygenSaturation", T_WRIST = "HKQuantityTypeIdentifierAppleSleepingWristTemperature";
  const T_MASS = "HKQuantityTypeIdentifierBodyMass", T_SYS = "HKQuantityTypeIdentifierBloodPressureSystolic";
  const T_DIA = "HKQuantityTypeIdentifierBloodPressureDiastolic", IN_BED = "HKCategoryValueSleepAnalysisInBed";
  const WANTED = new Set([T_SDNN, T_RMSSD, T_RHR, T_SLEEP, T_STEPS, T_ENERGY, T_HR, T_RESP, T_SPO2, T_WRIST, T_MASS, T_SYS, T_DIA]);
  const HR_KEEP_DAYS = 120;
  const ASLEEP = {
    HKCategoryValueSleepAnalysisAsleep: "unspecified", HKCategoryValueSleepAnalysisAsleepUnspecified: "unspecified",
    HKCategoryValueSleepAnalysisAsleepCore: "core", HKCategoryValueSleepAnalysisAsleepDeep: "deep",
    HKCategoryValueSleepAnalysisAsleepREM: "rem",
  };
  const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  const BEAT = /<InstantaneousBeatsPerMinute\b[^>]*?\btime="([^"]*)"/g;
  const CLOCK = /(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?/;
  const ENT = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g;
  const ENTS = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  function unescapeXml(s) {
    if (!s.includes("&")) return s;
    return s.replace(ENT, (m, g) => {
      if (g[0] === "#") {
        const cp = (g[1] === "x" || g[1] === "X") ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return (cp > 0 && cp < 0x110000) ? String.fromCodePoint(cp) : "";
      }
      return ENTS[g];
    });
  }
  const MAX_TAG = 1 << 20;
  // Index of the '>' closing the tag at i, skipping '>' inside quoted values; -1 if incomplete. Linear.
  function tagEnd(buf, i) {
    let k = i;
    for (;;) {
      const g = buf.indexOf(">", k);
      if (g < 0) return -1;
      const q = buf.indexOf('"', k);
      if (q < 0 || q > g) return g;
      const q2 = buf.indexOf('"', q + 1);
      if (q2 < 0) return -1;
      k = q2 + 1;
    }
  }
  function rrFromClock(times) {
    const secs = [];
    for (const s of times) {
      const m = CLOCK.exec(s);
      if (!m) continue;
      const frac = m[4] ? parseFloat("0." + m[4]) : 0.0;
      secs.push((parseInt(m[1], 10) % 12) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + frac);
    }
    const rr = [];
    for (let i = 1; i < secs.length; i++) {
      const dlt = (((secs[i] - secs[i - 1]) % 43200) + 43200) % 43200;
      rr.push(dlt * 1000.0);
    }
    return rr;
  }
  function rmssd(rr, minPairs) {
    minPairs = minPairs === undefined ? 20 : minPairs;
    const rng = rr.filter((x) => x >= 300 && x <= 2000).sort((a, b) => a - b);
    if (rng.length < 2) return null;
    const k = rng.length;
    const med = k % 2 ? rng[(k - 1) / 2] : (rng[k / 2 - 1] + rng[k / 2]) / 2.0;
    const ok = rr.map((x) => x >= 300 && x <= 2000 && Math.abs(x - med) <= 0.25 * med);
    let ss = 0, cnt = 0;
    for (let i = 1; i < rr.length; i++) if (ok[i] && ok[i - 1]) { const dl = rr[i] - rr[i - 1]; ss += dl * dl; cnt++; }
    if (cnt < minPairs) return null;
    return Math.sqrt(ss / cnt);
  }
  function HealthScanner() {
    const st = { buf: "", sdnn: new Map(), rmssdBeats: new Map(), rmssdDev: new Map(), rhr: new Map(), sleep: [], records: 0,
      inBed: [], sums: new Map(), means: new Map(), hr: new Map(), sdnnTimes: [], body: new Map() };
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    function handle(tag, body) {
      const at = tag.indexOf('type="');
      if (at < 0) return;
      const typ = tag.slice(at + 6, tag.indexOf('"', at + 6));
      if (!WANTED.has(typ)) return;
      const a = {};
      for (const m of tag.matchAll(ATTR)) a[m[1]] = unescapeXml(m[2]);
      const start = a.startDate || "";
      if (start.length < 13 || parseDay(start.slice(0, 10)) === null) return;
      st.records++;
      const date = start.slice(0, 10), hour = num(start.slice(11, 13));
      if (typ === T_SLEEP) {
        const val = a.value || "", stage = ASLEEP[val];
        const t0 = parseTime(start), t1 = parseTime(a.endDate || "");
        if (t0 !== null && t1 !== null && t1 > t0) {
          if (stage) st.sleep.push([t0, t1, start, a.endDate || "", stage, a.sourceName || ""]);
          else if (val === IN_BED) st.inBed.push([t0, t1, start, a.endDate || ""]);
        }
        return;
      }
      let v = num(a.value);
      if (v === null) return;
      if (typ === T_STEPS || typ === T_ENERGY) {
        if (typ === T_ENERGY && a.unit === "kJ") v = v / 4.184;
        const key = typ + "\u0000" + date + "\u0000" + (a.sourceName || "");
        st.sums.set(key, (st.sums.get(key) || 0) + v);
      } else if (typ === T_RESP || typ === T_SPO2 || typ === T_WRIST) {
        if (typ === T_SPO2 && v <= 1.0) v = v * 100.0;
        if (typ === T_WRIST && a.unit === "degF") v = (v - 32.0) / 1.8;
        push(st.means, typ + "\u0000" + date, v);
      } else if (typ === T_HR) {
        const t0 = parseTime(start), loc = parseTime(start.slice(0, 19));
        if (t0 !== null && loc !== null) {
          const m = Math.floor(t0 / 60), b = st.hr.get(m);
          if (!b) st.hr.set(m, [v, 1, loc - t0]); else { b[0] += v; b[1] += 1; }
        }
      } else if (typ === T_MASS || typ === T_SYS || typ === T_DIA) {
        if (typ === T_MASS && a.unit === "lb") v = v * 0.45359237;
        st.body.set(typ + "\u0000" + start, v);
      } else if (typ === T_RHR) push(st.rhr, date, v);
      else if (typ === T_RMSSD) push(st.rmssdDev, date, [hour, v]);
      else {
        push(st.sdnn, date, [hour, v]);
        if (hour !== null) st.sdnnTimes.push([parseDay(date), hour, v]);
        if (body) {
          const times = [];
          for (const m of body.matchAll(BEAT)) times.push(m[1]);
          const r = rmssd(rrFromClock(times));
          if (r !== null) push(st.rmssdBeats, date, [hour, r]);
        }
      }
    }
    function feed(chunk) {
      st.buf += chunk;
      const buf = st.buf;
      let pos = 0;
      for (;;) {
        const i = buf.indexOf("<Record", pos);
        if (i < 0) { st.buf = buf.slice(Math.max(pos, buf.length - 8)); return; }
        if (i + 7 >= buf.length) { st.buf = buf.slice(i); return; }
        if (!" \t\r\n/>".includes(buf[i + 7])) { pos = i + 7; continue; }
        const e = tagEnd(buf, i);
        if (e < 0) {
          // no real Record tag is this long: skip the malformed one instead of buffering forever
          if (buf.length - i > MAX_TAG) { pos = i + 7; continue; }
          st.buf = buf.slice(i); return;
        }
        const tag = buf.slice(i, e + 1);
        let body = "", nxt = e + 1;
        if (!tag.endsWith("/>") && tag.includes(T_SDNN)) {
          const c = buf.indexOf("</Record>", e + 1);
          if (c < 0) {
            if (buf.length - i < 4000000) { st.buf = buf.slice(i); return; }
          } else { body = buf.slice(e + 1, c); nxt = c + 9; }
        }
        handle(tag, body);
        pos = nxt;
      }
    }
    return { feed, result: () => healthDays(st), extras: () => healthExtras(st), state: st, get records() { return st.records; } };
  }
  function morningGeo(pairs) {
    const early = pairs.filter(([h, v]) => h !== null && h < 10 && v > 0).map((p) => p[1]);
    const use = early.length ? early : pairs.filter((p) => p[1] > 0).map((p) => p[1]);
    if (!use.length) return null;
    let s = 0;
    for (const v of use) s += Math.log(v);
    return Math.exp(s / use.length);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function sleepNights(intervals) {
    const ivs = intervals.map((x) => [x[0], x[1], x[2], x[3]])
      .sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]) || cmp(x[2], y[2]) || cmp(x[3], y[3]));
    const merged = [];
    for (const [a, b, sa, sb] of ivs) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) { if (b > last[1]) { last[1] = b; last[3] = sb; } }
      else merged.push([a, b, sa, sb]);
    }
    const blocks = [];
    for (const m of merged) {
      const blk = blocks[blocks.length - 1];
      if (blk && m[0] - blk.end <= 3600) { blk.end = m[1]; blk.end_s = m[3]; blk.asleep += m[1] - m[0]; }
      else blocks.push({ start: m[0], end: m[1], start_s: m[2], end_s: m[3], asleep: m[1] - m[0] });
    }
    const main = new Map(), nap = new Map();
    for (const blk of blocks) {
      const h = num(blk.start_s.slice(11, 13)) || 0;
      if (blk.asleep < 3 * 3600 && h >= 9 && h < 20) {
        const z = parseDay(blk.start_s.slice(0, 10));
        nap.set(z, (nap.get(z) || 0) + blk.asleep / 3600.0);
      } else {
        const z = parseDay(blk.end_s.slice(0, 10));
        main.set(z, (main.get(z) || 0) + blk.asleep / 3600.0);
      }
    }
    return [main, nap];
  }
  function sleepStages(intervals) {
    const per = new Map();
    for (const [a, b, , sb, stage, src] of intervals) {
      const z = parseDay(sb.slice(0, 10));
      if (z === null) continue;
      if (!per.has(z)) per.set(z, new Map());
      const bySrc = per.get(z);
      if (!bySrc.has(src)) bySrc.set(src, {});
      const o = bySrc.get(src);
      o[stage] = (o[stage] || 0) + (b - a) / 3600.0;
    }
    const out = new Map();
    for (const [z, bySrc] of per) {
      let best = null, bestV = -Infinity;
      for (const src of Array.from(bySrc.keys()).sort(cmp)) {
        const v = sum(Object.values(bySrc.get(src)));
        if (v > bestV) { best = src; bestV = v; }
      }
      const o = bySrc.get(best);
      out.set(z, { core: o.core || 0, deep: o.deep || 0, rem: o.rem || 0, unspecified: o.unspecified || 0 });
    }
    return out;
  }
  const DAY_KEYS = ["rmssd", "sdnn", "rhr", "sleep", "nap", "stages", "in_bed", "bed_min", "wake_min", "steps", "active_kcal", "resp", "spo2", "wrist_temp"];
  function blankDay(z) { const d = { date: z }; for (const k of DAY_KEYS) d[k] = null; return d; }
  const clockMin = (s) => parseInt(s.slice(11, 13), 10) * 60 + parseInt(s.slice(14, 16), 10);
  function mainWindows(intervals) {
    const ivs = intervals.map((x) => [x[0], x[1], x[2], x[3]]).sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]) || cmp(x[2], y[2]) || cmp(x[3], y[3]));
    const blocks = [];
    for (const [a, b, sa, sb] of ivs) {
      const last = blocks[blocks.length - 1];
      if (last && a - last[1] <= 3600) { if (b > last[1]) { last[1] = b; last[3] = sb; } }
      else blocks.push([a, b, sa, sb]);
    }
    const out = new Map();
    for (const [a, b, sa, sb] of blocks) {
      const h = parseInt(sa.slice(11, 13), 10);
      if (b - a < 3 * 3600 && h >= 9 && h < 20) continue;
      const z = parseDay(sb.slice(0, 10));
      if (!out.has(z) || b - a > out.get(z)[1] - out.get(z)[0]) out.set(z, [a, b, sa, sb]);
    }
    return out;
  }
  function inBedHours(intervals) {
    const ivs = intervals.map((x) => x.slice()).sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]) || cmp(x[2], y[2]) || cmp(x[3], y[3]));
    const merged = [];
    for (const [a, b, sa, sb] of ivs) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) { if (b > last[1]) { last[1] = b; last[3] = sb; } }
      else merged.push([a, b, sa, sb]);
    }
    const out = new Map();
    for (const [a, b, , sb] of merged) { const z = parseDay(sb.slice(0, 10)); out.set(z, (out.get(z) || 0) + (b - a) / 3600.0); }
    return out;
  }
  function healthExtras(st) {
    const hr = [];
    if (st.hr.size) {
      const keys = Array.from(st.hr.keys()).sort((a, b) => a - b);
      const lo = keys[keys.length - 1] - HR_KEEP_DAYS * 1440;
      for (const m of keys) if (m > lo) { const [s_, c, off] = st.hr.get(m); hr.push([m, s_ / c, off]); }
    }
    const body = new Map();
    const bkeys = Array.from(st.body.keys()).sort(cmp);
    for (const key of bkeys) {
      const [typ, start] = key.split("\u0000");
      const k16 = start.slice(0, 16);
      if (!body.has(k16)) body.set(k16, { date: parseDay(start.slice(0, 10)), kg: null, sys: null, dia: null });
      body.get(k16)[typ === T_MASS ? "kg" : typ === T_SYS ? "sys" : "dia"] = st.body.get(key);
    }
    const sd2 = st.sdnnTimes.slice().sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]) || cmp(x[2], y[2]));
    return { hr, sdnn: sd2, body: Array.from(body.keys()).sort(cmp).map((k) => body.get(k)) };
  }
  function healthDays(st) {
    const days = new Map();
    const row = (z) => { if (!days.has(z)) days.set(z, blankDay(z)); return days.get(z); };
    for (const [date, pairs] of st.sdnn) row(parseDay(date)).sdnn = morningGeo(pairs);
    for (const src of [st.rmssdBeats, st.rmssdDev]) {
      for (const [date, pairs] of src) { const v = morningGeo(pairs); if (v !== null) row(parseDay(date)).rmssd = v; }
    }
    for (const [date, vals] of st.rhr) row(parseDay(date)).rhr = sum(vals) / vals.length;
    const [main, nap] = sleepNights(st.sleep);
    for (const [z, h] of main) row(z).sleep = h;
    for (const [z, h] of nap) row(z).nap = h;
    for (const [z, s] of sleepStages(st.sleep)) row(z).stages = s;
    for (const [z, w] of mainWindows(st.sleep)) {
      const r = row(z), cb = clockMin(w[2]);
      r.bed_min = cb >= 720 ? cb - 720 : cb + 720;
      r.wake_min = clockMin(w[3]);
      r.in_bed = (w[1] - w[0]) / 3600.0;
    }
    for (const [z, h] of inBedHours(st.inBed)) { const r = row(z); if (h > (r.in_bed || 0)) r.in_bed = h; }
    const best = new Map();
    for (const key of Array.from(st.sums.keys()).sort(cmp)) {
      const [typ, date] = key.split("\u0000"), k2 = typ + "\u0000" + date, v = st.sums.get(key);
      if (v > (best.has(k2) ? best.get(k2) : -1)) best.set(k2, v);
    }
    for (const [k2, v] of best) { const [typ, date] = k2.split("\u0000"); row(parseDay(date))[typ === T_STEPS ? "steps" : "active_kcal"] = v; }
    for (const [k2, vals] of st.means) {
      const [typ, date] = k2.split("\u0000");
      row(parseDay(date))[typ === T_RESP ? "resp" : typ === T_SPO2 ? "spo2" : "wrist_temp"] = sum(vals) / vals.length;
    }
    return Array.from(days.keys()).sort((a, b) => a - b).map((z) => days.get(z));
  }
  function findExportName(names) {
    let best = null;
    for (const n of names) {
      const base = n.split("/").pop();
      if (base === "export.xml" && (best === null || n.length < best.length)) best = n;
    }
    return best;
  }
  // ZIP: end of central directory (with ZIP64), central directory entries, local header.
  function u16(b, p) { return b[p] | (b[p + 1] << 8); }
  function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 16777216; }
  function u64(b, p) { return u32(b, p) + u32(b, p + 4) * 4294967296; }
  function zipEnd(tail, tailStart) {
    // tail: last bytes of the file (at least 22, up to 65557 + 76); tailStart: its offset in the file
    let e = -1;
    for (let p = tail.length - 22; p >= 0; p--) {
      if (tail[p] === 0x50 && tail[p + 1] === 0x4B && tail[p + 2] === 0x05 && tail[p + 3] === 0x06) { e = p; break; }
    }
    if (e < 0) throw err("zip", "Not a zip file (no end of central directory).");
    let count = u16(tail, e + 10), size = u32(tail, e + 12), offset = u32(tail, e + 16);
    if (count === 0xFFFF || size === 0xFFFFFFFF || offset === 0xFFFFFFFF) {
      const l = e - 20;
      if (l < 0 || u32(tail, l) !== 0x07064b50) throw err("zip", "ZIP64 locator not found.");
      const rec = u64(tail, l + 8) - tailStart;
      if (rec < 0 || rec + 56 > tail.length || u32(tail, rec) !== 0x06064b50) throw err("zip", "ZIP64 end record not found.");
      count = u64(tail, rec + 32); size = u64(tail, rec + 40); offset = u64(tail, rec + 48);
    }
    return { count, size, offset };
  }
  function zipCentral(cd) {
    const out = [];
    let p = 0;
    const dec = new TextDecoder("utf-8");
    while (p + 46 <= cd.length && u32(cd, p) === 0x02014b50) {
      const method = u16(cd, p + 10);
      let csize = u32(cd, p + 20), usize = u32(cd, p + 24);
      const nlen = u16(cd, p + 28), elen = u16(cd, p + 30), clen = u16(cd, p + 32);
      let lho = u32(cd, p + 42);
      const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
      let x = p + 46 + nlen;
      const xend = x + elen;
      while (x + 4 <= xend) {
        const id = u16(cd, x), sz = u16(cd, x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xFFFFFFFF) { usize = u64(cd, q); q += 8; }
          if (csize === 0xFFFFFFFF) { csize = u64(cd, q); q += 8; }
          if (lho === 0xFFFFFFFF) { lho = u64(cd, q); q += 8; }
        }
        x += 4 + sz;
      }
      out.push({ name, method, csize, usize, lho });
      p = xend + clen;
    }
    return out;
  }
  function zipDataOffset(local30, lho) {
    if (u32(local30, 0) !== 0x04034b50) throw err("zip", "Bad local file header.");
    return lho + 30 + u16(local30, 26) + u16(local30, 28);
  }
  const CSV_COLS = { date: "date", day: "date", hrv_ms: "rmssd", rmssd_ms: "rmssd", rmssd: "rmssd", hrv: "rmssd",
    sdnn_ms: "sdnn", sdnn: "sdnn", resting_hr: "rhr", rhr: "rhr", sleep_hours: "sleep", sleep_h: "sleep", sleep: "sleep",
    nap_hours: "nap", nap_h: "nap" };
  const clean = (c) => c.trim().replace(/^"+|"+$/g, "").trim();
  function parseDailyCsv(text) {
    if (text.length > MAX_HEALTH_BYTES) throw err("size", "CSV is over the size limit.");
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim());
    if (!lines.length) throw err("csv", "The CSV is empty.");
    if (lines.length > MAX_ROWS + 1) throw err("rows", "The CSV has more than 50,000 rows.");
    const first = lines[0];
    const sep = first.includes("\t") ? "\t" : (first.includes(";") && !first.includes(",") ? ";" : ",");
    const cells = first.split(sep).map((c) => clean(c).toLowerCase());
    let cols, body, rowNo;
    if (parseDay(cells[0]) === null) {
      cols = cells.map((c) => CSV_COLS[c] || null);
      if (!cols.includes("date")) throw err("csv", "The header has no 'date' column.");
      body = lines.slice(1); rowNo = 2;
    } else { cols = ["date", "rmssd", "rhr", "sleep"]; body = lines; rowNo = 1; }
    const out = [];
    for (const ln of body) {
      const n = rowNo++;
      const parts = ln.split(sep).map(clean);
      const rec = blankDay(null);
      for (let c = 0; c < Math.min(cols.length, parts.length); c++) {
        const col = cols[c], v = parts[c];
        if (col === null) continue;
        if (col === "date") rec.date = parseDay(v);
        else if (v !== "") {
          const x = num(sep === ";" ? v.replace(/,/g, ".") : v); // ";" files use decimal commas
          if (x === null) throw err("csv", "Row " + n + ": '" + v.slice(0, 20) + "' is not a number.");
          rec[col] = x;
        }
      }
      if (rec.date === null) throw err("csv", "Row " + n + ": the date must be YYYY-MM-DD.");
      for (const k of ["rmssd", "sdnn"]) if (rec[k] !== null && !(rec[k] >= 1 && rec[k] <= 400)) throw err("csv", "Row " + n + ": HRV " + rec[k] + " ms is outside 1 to 400.");
      if (rec.rhr !== null && !(rec.rhr >= 20 && rec.rhr <= 150)) throw err("csv", "Row " + n + ": resting HR " + rec.rhr + " is outside 20 to 150.");
      if (rec.sleep !== null && !(rec.sleep >= 0 && rec.sleep <= 20)) throw err("csv", "Row " + n + ": sleep " + rec.sleep + " h is outside 0 to 20.");
      out.push(rec);
    }
    return out;
  }
  const BASE_DAYS = 60, MIN_BASE = 14, MIN_WEEK = 3;
  function windowVals(m, a, b) { const o = []; for (let z = a; z <= b; z++) { const v = m.get(z); if (v !== undefined && v !== null) o.push(v); } return o; }
  function readiness(daily, day, s, loads) {
    const by = new Map();
    for (const r of daily) by.set(r.date, r);
    const getLoad = (z) => (loads ? (loads instanceof Map ? loads.get(z) : loads[z]) : undefined) || 0;
    const series = (key) => { const m = new Map(); for (const [z, r] of by) if (r[key] !== null && r[key] !== undefined) m.set(z, r[key]); return m; };
    const out = { day, hrv: null, rhr: null, sleep: null, flags: [], state: "none" };
    let available = 0, metric = null;
    for (const key of ["rmssd", "sdnn"]) {
      if (windowVals(series(key), day - BASE_DAYS, day - 1).filter((v) => v > 0).length >= MIN_BASE) { metric = key; break; }
    }
    if (metric) {
      const ser = new Map();
      for (const [z, v] of series(metric)) if (v > 0) ser.set(z, Math.log(v));
      const base = windowVals(ser, day - BASE_DAYS, day - 1), week = windowVals(ser, day - 6, day);
      const mu = mean(base), sig = sd(base);
      const info = { metric, base_n: base.length, week_n: week.length, mean: mu, sd: sig, lo: mu - 0.5 * sig, hi: mu + 0.5 * sig, roll: null, status: "insufficient" };
      if (week.length >= MIN_WEEK) {
        const roll = mean(week);
        info.roll = roll;
        info.status = roll < info.lo ? "low" : (roll > info.hi ? "high" : "normal");
        available++;
        if (info.status === "low") out.flags.push("hrv");
      }
      out.hrv = info;
    }
    const rser = series("rhr");
    const rbase = windowVals(rser, day - BASE_DAYS, day - 1);
    if (rbase.length >= MIN_BASE) {
      const recent = windowVals(rser, day - 2, day);
      const mu = mean(rbase), sig = sd(rbase), lim = mu + Math.max(sig, 1.0);
      const info = { base_n: rbase.length, mean: mu, sd: sig, limit: lim, recent: null, status: "insufficient" };
      if (recent.length) {
        const cur = mean(recent);
        info.recent = cur;
        info.status = cur > lim ? "high" : "normal";
        available++;
        if (info.status === "high") out.flags.push("rhr");
      }
      out.rhr = info;
    }
    const sser = series("sleep"), nser = series("nap");
    if (sser.get(day) !== undefined) {
      const b = s.sleep_base;
      let debt = 0;
      for (let z = day - 7; z < day; z++) if (sser.get(z) !== undefined) debt += Math.max(0, b - sser.get(z));
      const nap = nser.get(day - 1) || 0, ld = getLoad(day - 1);
      let need = b + s.sleep_debt_share * debt + s.sleep_load_per100 * ld / 100.0 - nap;
      need = Math.max(need, 0.5 * b);
      const ratio = sser.get(day) / need;
      out.sleep = { hours: sser.get(day), need, base: b, debt, nap, load_term: s.sleep_load_per100 * ld / 100.0, ratio, status: ratio < 0.85 ? "short" : "ok" };
      available++;
      if (ratio < 0.85) out.flags.push("sleep");
    }
    if (available) {
      const nf = out.flags.length;
      out.state = nf >= 2 ? "several_off" : (nf === 1 ? "one_off" : "clear");
    }
    return out;
  }
  function explain(r) {
    if (r.state === "none") return "Not enough recovery data yet: 14 days of baseline are needed for HRV or resting HR, or a sleep entry for last night.";
    const parts = [];
    const h = r.hrv;
    if (h && h.roll !== null) {
      const label = h.metric === "rmssd" ? "rMSSD" : "SDNN";
      const word = { low: "below", high: "above", normal: "inside" }[h.status];
      parts.push("7-day HRV (" + label + ") is " + word + " your normal range");
    }
    const k = r.rhr;
    if (k && k.recent !== null) parts.push(k.status === "high" ? "resting HR is above your usual" : "resting HR is normal");
    const sl = r.sleep;
    if (sl) parts.push("sleep was " + sl.hours.toFixed(1) + " h of a " + sl.need.toFixed(1) + " h need");
    const lead = { clear: "No input is off its baseline.", one_off: "One input is off its baseline.",
      several_off: "Two or more inputs are off their baselines." }[r.state];
    return lead + " " + parts.join("; ") + ".";
  }

  // ------------------------------------------------------------------ example athlete
  const LAT0 = 41.0, LON0 = -40.0;
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rnd) {
    let u = rnd();
    const v = rnd();
    if (u < 1e-12) u = 1e-12;
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }
  const rnd5 = (x) => Math.floor(x + 0.5);
  function routeXY(route, u) {
    if (route === 0) {
      const th = u / 1050.0, r = 1.0 + 0.05 * Math.sin(5.0 * th);
      return [1300.0 * r * Math.cos(th) - 1300.0, 800.0 * r * Math.sin(th)];
    }
    if (route === 1) return [u * 0.83 + 150.0 * Math.sin(u / 400.0), u * 0.56 + 80.0 * Math.cos(u / 530.0) - 80.0];
    const th = u / 6500.0;
    return [7000.0 * Math.cos(th) + 1500.0 * Math.cos(3.0 * th) - 8500.0, 5000.0 * Math.sin(th) + 900.0 * Math.sin(2.0 * th)];
  }
  function terrain(x, y) { return 120.0 + 35.0 * Math.sin(x / 900.0) + 22.0 * Math.cos(y / 650.0) + 10.0 * Math.sin((x + y) / 300.0); }
  function toLatLon(x, y) {
    const k = Math.PI / 180.0 * 6371008.8;
    return [LAT0 + y / k, LON0 + x / (k * Math.cos(LAT0 * Math.PI / 180.0))];
  }
  function plan(kind, vol, rnd) {
    if (kind === "intervals") {
      let ph = [[2000.0, 3.0, "m"]];
      for (let r = 0; r < 6; r++) ph = ph.concat([[800.0, 4.35, "m"], [400.0, 2.6, "m"]]);
      return [ph.concat([[2000.0, 2.9, "m"]]), 0, "Intervals 6 x 800 m"];
    }
    if (kind === "tempo") return [[[2000.0, 3.0, "m"], [6000.0 * vol, 3.75, "m"], [2000.0, 2.9, "m"]], 1, "Tempo, ridge road"];
    if (kind === "easy") return [[[6000.0 + 2000.0 * rnd(), 3.0, "m"]], 0, "Easy run, reservoir loop"];
    if (kind === "long") { const L = 14000.0 * vol + 2000.0 * rnd(); return [[[L - 3000.0, 2.95, "m"], [3000.0, 3.3, "m"]], 1, "Long run, ridge road"]; }
    if (kind === "ride") return [[[3600.0 + 1200.0 * rnd(), 150.0, "s"]], 2, "Easy ride, island loop"];
    return [[[7200.0 * vol + 1800.0 * rnd(), 165.0, "s"]], 2, "Long ride, island loop"];
  }
  function exActivity(kind, startT, vol, rnd, s) {
    const [phases, route, name] = plan(kind, vol, rnd);
    const ride = route === 2, dt = ride ? 3.0 : 2.0;
    const mx = s.max_hr - 2.0, rest = s.rest_hr - 2.0;
    let total = 0;
    for (const p of phases) total += p[0];
    const A = newActivity("example", name, ride ? "ride" : "run");
    let u = 0, dir = 1.0, travelled = 0, el = 0, h = rest + 30.0, v = 0, phase = 0, used = 0, stopAt = -1.0;
    if (kind === "easy" && rnd() < 0.7) stopAt = 1500.0 + 3000.0 * rnd();
    let stopped = 0;
    const drift = gauss(rnd) * 2.0;
    let gx = 0, gy = 0;
    while (phase < phases.length) {
      const [amt, target, unit] = phases[phase];
      const [x, y] = routeXY(route, u), [x2, y2] = routeXY(route, u + dir * 5.0);
      const ez = terrain(x, y), grade = (terrain(x2, y2) - ez) / 5.0;
      let p, vt, rel;
      if (ride) {
        p = target * (1.0 + 8.0 * grade) * (1.0 + 0.05 * gauss(rnd));
        if (grade < -0.03 || p < 0) p = 0.0;
        vt = 7.5 * Math.pow(Math.max(p, 60.0) / 160.0, 1.0 / 3.0) * (1.0 - 6.0 * grade);
        vt = Math.min(16.0, Math.max(2.5, vt));
        rel = p / 240.0;
      } else { p = null; vt = target * (1.0 - 2.5 * grade); rel = target / 4.0; }
      if (stopAt >= 0 && travelled >= stopAt && stopped < 40.0) { vt = 0.0; stopped += dt; }
      v = v + (vt - v) * 0.5;
      if (v < 0.05) v = 0.0;
      let hrT = rest + (mx - rest) * (0.25 + 0.62 * Math.pow(rel, 1.5)) + 120.0 * grade + 4.0 * el / 3600.0;
      if (vt === 0.0) hrT = rest + (mx - rest) * 0.35;
      h = h + (hrT - h) * (1.0 - Math.exp(-dt / 25.0));
      gx = 0.95 * gx + 0.3 * gauss(rnd);
      gy = 0.95 * gy + 0.3 * gauss(rnd);
      const [la, lo] = toLatLon(x + gx, y + gy);
      A.t.push(startT + el); A.lat.push(la); A.lon.push(lo);
      A.ele.push(ez + drift + 0.3 * gauss(rnd));
      A.hr.push(rnd5(h + 0.8 * gauss(rnd)));
      if (ride) { A.pwr.push(rnd5(p)); A.cad.push(p > 0 ? rnd5(86.0 + 3.0 * gauss(rnd)) : 0.0); }
      else { A.pwr.push(null); A.cad.push(v > 0 ? rnd5(166.0 + 10.0 * rel + 2.0 * gauss(rnd)) : 0.0); }
      A.dist.push(null);
      const ds = v * dt;
      const [xa, ya] = routeXY(route, u + 0.5), [xb, yb] = routeXY(route, u - 0.5);
      const stretch = Math.sqrt((xa - xb) * (xa - xb) + (ya - yb) * (ya - yb));
      u += dir * ds / Math.max(stretch, 1e-6);
      travelled += ds; el += dt;
      used += unit === "s" ? dt : ds;
      if (route === 1 && dir > 0 && travelled >= total / 2.0) dir = -1.0;
      if (used >= amt) { phase++; used = 0.0; }
    }
    A.start = A.t[0];
    return A;
  }
  const WEEK = { 1: "intervals", 2: "ride", 3: "tempo", 4: "easy", 5: "long", 6: "longride" };
  const EFFORT_FACTOR = { intervals: 1.6, tempo: 1.4, long: 1.1, longride: 0.9, ride: 0.7, easy: 0.8 };
  function generateExample(endDay, days, seed, settings) {
    days = days || 90; seed = seed === undefined ? 20261021 : seed;
    const s = Object.assign({ max_hr: 190.0, rest_hr: 50.0 }, settings || {});
    const rnd = mulberry32(seed);
    const startDay = endDay - days + 1;
    const acts = [], effort = new Map();
    for (let z = startDay; z <= endDay; z++) {
      const wd = (z + 3) % 7, k = Math.floor((z - startDay) / 7);
      const vol = (1.0 + 0.04 * k) * (k % 4 === 3 ? 0.75 : 1.0);
      let kind = WEEK[wd] || null;
      if (kind === "easy" && rnd() < 0.35) kind = null;
      if (z > endDay - 10 && wd === 0) kind = "easy";
      if (kind === null) { effort.set(z, 0.0); continue; }
      const hour = (kind === "intervals" || kind === "tempo" || kind === "easy") ? 6.0 : 7.5;
      const startT = z * 86400.0 + hour * 3600.0 + rnd5(rnd() * 1800.0);
      const a = exActivity(kind, startT, vol, rnd, s);
      acts.push(a);
      effort.set(z, (a.t[a.t.length - 1] - a.t[0]) / 60.0 * EFFORT_FACTOR[kind]);
    }
    const daily = [];
    let acute = 30.0, chronic = 30.0;
    for (let z = startDay; z <= endDay; z++) {
      const L = effort.get(z - 1) || 0.0;
      acute += (L - acute) * (1.0 - Math.exp(-1.0 / 7.0));
      chronic += (L - chronic) * (1.0 - Math.exp(-1.0 / 42.0));
      const imb = acute - chronic;
      const ln = 4.15 - 0.0025 * imb + 0.07 * gauss(rnd);
      const rhr = 48.0 + 0.03 * imb + 1.0 * gauss(rnd);
      let sleep = Math.min(9.5, Math.max(5.6, 7.9 + 0.4 * gauss(rnd)));
      const nap = ((z + 3) % 7 >= 5 && rnd() < 0.15) ? 0.5 : null;
      let miss = rnd();
      if (z === endDay) { sleep = 5.8; miss = 1.0; }
      else if (z === endDay - 1) sleep = 6.4;
      const rec = { date: z, rmssd: miss > 0.06 ? Math.exp(ln) : null, sdnn: null,
        rhr: (miss < 0.03 || miss > 0.09) ? rnd5(rhr) : null,
        sleep: !(miss > 0.09 && miss < 0.11) ? sleep : null, nap, stages: null };
      if (rec.sleep !== null) rec.stages = { core: sleep * 0.6, deep: sleep * 0.16, rem: sleep * 0.24, unspecified: 0.0 };
      daily.push(rec);
    }
    return [acts, daily];
  }

  return {
    err, num, daysFromCivil, civilFromDays, dayStr, parseDay, parseTime, haversine, projectLocal, mean, sd,
    FIT_EPOCH, crc16, decodeFit, xmlText, checkXml, parseGpxDoc, parseTcxDoc, newActivity,
    DEFAULTS, TARGETS, settingsWith, cumdist, movingMask, smooth, zigzag, elevation, filledSmoothed, interpAt,
    splits, badPrefix, fastest, zoneBounds, heart, power, minettiCost, gradeAdjusted, analyze,
    loadSeries, dailyLoads,
    MAX_HEALTH_BYTES, MAX_ACTIVITY_BYTES, unescapeXml, rrFromClock, rmssd, HealthScanner, sleepNights, sleepStages,
    findExportName, blankDay, DAY_KEYS, healthExtras, interpTime, lapTable, maxSpeed, analyzeSummary, bisectLeft, cmp, sum, zipEnd, zipCentral, zipDataOffset, parseDailyCsv, readiness, explain,
    mulberry32, generateExample, LAT0, LON0,
  };
})();
