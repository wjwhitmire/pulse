// PulseFHIR: import FHIR R4 JSON (Bundle or single resources, including Apple
// Health clinical-records/*.json files and Blue Button 2.0 bundles) and decode
// SMART Health Card JWS payloads. Extracts Patient (minimal), Condition,
// MedicationStatement, MedicationRequest, Immunization, AllergyIntolerance
// and Observation (labs and vitals). Pure functions. Only plain JSON data is
// accepted; nothing is interpreted beyond "in or out of the lab's own range".
var PulseFHIR = (function () {
  "use strict";

  var MAX_TEXT = 32 * 1024 * 1024;     // input JSON text
  var MAX_NODES = 2000000;             // JSON values walked
  var MAX_DEPTH = 64;
  var MAX_RESOURCES = 100000;
  var MAX_STR = 2000;                  // per extracted display string
  var BAD_KEYS = { "__proto__": 1, "constructor": 1, "prototype": 1 };

  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function own(o, k) { return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k); }
  function get(o, k) { return own(o, k) ? o[k] : undefined; }
  function arr(v) { return Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]); }

  // ------------------------------------------------------------ plain JSON
  function isPlainObject(o) {
    if (Object.prototype.toString.call(o) !== "[object Object]") return false;
    var p = Object.getPrototypeOf(o);
    // Object.prototype of this realm or another (its own prototype is null), or null.
    return p === null || Object.getPrototypeOf(p) === null;
  }

  // Deep copy of plain JSON data into fresh objects, dropping keys that could
  // pollute prototypes. Throws for anything JSON could not have produced.
  function sanitize(v) {
    var count = 0;
    function walk(x, depth) {
      if (++count > MAX_NODES) throw err("size", "The file has too many values.");
      if (depth > MAX_DEPTH) throw err("depth", "The file is nested too deeply.");
      if (x === null || typeof x === "boolean" || typeof x === "string") return x;
      if (typeof x === "number") { if (!isFinite(x)) throw err("json", "Numbers must be finite."); return x; }
      if (Array.isArray(x)) {
        var a = [];
        for (var i = 0; i < x.length; i++) a.push(walk(x[i], depth + 1));
        return a;
      }
      if (typeof x === "object" && isPlainObject(x)) {
        if (Object.getOwnPropertySymbols(x).length) throw err("json", "Objects with symbol keys are not JSON.");
        var o = {}, keys = Object.getOwnPropertyNames(x);
        for (var k = 0; k < keys.length; k++) {
          var key = keys[k];
          var d = Object.getOwnPropertyDescriptor(x, key);
          if (!own(d, "value")) throw err("json", "Objects with getters are not JSON.");
          if (Object.prototype.hasOwnProperty.call(BAD_KEYS, key)) continue;
          o[key] = walk(d.value, depth + 1);
        }
        return o;
      }
      throw err("json", "Only plain JSON data is accepted (found " + (typeof x) + ").");
    }
    return walk(v, 0);
  }

  function parseJson(input) {
    if (typeof input === "string") {
      if (input.length > MAX_TEXT) throw err("size", "The file is over the size limit.");
      var t = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
      var first = t.replace(/^\s+/, "").charAt(0);
      if (first !== "{" && first !== "[") throw err("format", "This is not a FHIR JSON file.");
      var data;
      try { data = JSON.parse(t); } catch (e) { throw err("json", "The file is not valid JSON."); }
      return sanitize(data);
    }
    if (input !== null && typeof input === "object") return sanitize(input);
    throw err("format", "Expected FHIR JSON text or parsed JSON.");
  }

  // ------------------------------------------------------------ helpers
  function str(v) {
    if (typeof v !== "string") return null;
    var s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "").trim();
    return s ? (s.length > MAX_STR ? s.slice(0, MAX_STR) : s) : null;
  }
  var DATE_RE = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;
  function date(v) { var s = str(v); return s && DATE_RE.test(s) ? s : null; }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

  function codings(cc) {
    var out = [], cs = arr(get(cc, "coding"));
    for (var i = 0; i < cs.length && i < 20; i++) {
      var c = cs[i];
      if (!c || typeof c !== "object") continue;
      out.push({ system: str(get(c, "system")), code: str(get(c, "code")), display: str(get(c, "display")) });
    }
    return out;
  }
  function ccText(cc) {
    if (!cc || typeof cc !== "object") return null;
    var t = str(get(cc, "text"));
    if (t) return t;
    var cs = codings(cc);
    for (var i = 0; i < cs.length; i++) if (cs[i].display) return cs[i].display;
    for (i = 0; i < cs.length; i++) if (cs[i].code) return cs[i].code;
    return null;
  }
  function firstCode(cc) { var cs = codings(cc); return cs.length ? cs[0].code : null; }
  function codeIn(cc, system) {
    var cs = codings(cc);
    for (var i = 0; i < cs.length; i++) if (cs[i].system === system && cs[i].code) return cs[i].code;
    return null;
  }
  var LOINC = "http://loinc.org";
  function quantity(q) {
    if (!q || typeof q !== "object") return null;
    var v = num(get(q, "value"));
    if (v === null) return null;
    return { value: v, unit: str(get(q, "unit")) || str(get(q, "code")), code: str(get(q, "code")), comparator: str(get(q, "comparator")) };
  }
  function dateOf(r, base) {
    return date(get(r, base + "DateTime")) || date(get(get(r, base + "Period"), "start")) || date(get(r, base + "Instant")) || date(get(r, base + "Date")) || null;
  }
  function refDisplay(ref) { return str(get(ref, "display")); }

  // Contained or bundle-level Medication lookup for medicationReference.
  function medicationName(r, meds) {
    var t = ccText(get(r, "medicationCodeableConcept"));
    if (t) return { text: t, codes: codings(get(r, "medicationCodeableConcept")) };
    var ref = get(r, "medicationReference");
    var ref_s = str(get(ref, "reference"));
    if (ref_s) {
      var m = null;
      if (ref_s.charAt(0) === "#") {
        var cont = arr(get(r, "contained"));
        for (var i = 0; i < cont.length; i++) if (get(cont[i], "resourceType") === "Medication" && "#" + get(cont[i], "id") === ref_s) m = cont[i];
      } else if (meds.has(ref_s)) m = meds.get(ref_s);
      if (m) { var mt = ccText(get(m, "code")); if (mt) return { text: mt, codes: codings(get(m, "code")) }; }
    }
    var d = refDisplay(ref);
    return d ? { text: d, codes: [] } : { text: null, codes: [] };
  }
  function dosageText(r, key) {
    var ds = arr(get(r, key)), out = [];
    for (var i = 0; i < ds.length && i < 5; i++) { var t = str(get(ds[i], "text")); if (t) out.push(t); }
    return out.length ? out.join("; ") : null;
  }

  // ------------------------------------------------------------ extractors
  function patient(r) {
    var names = arr(get(r, "name")), name = null;
    for (var i = 0; i < names.length && !name; i++) {
      var n = names[i];
      name = str(get(n, "text"));
      if (!name) {
        var given = arr(get(n, "given")).map(str).filter(Boolean).join(" ");
        var fam = str(get(n, "family"));
        name = str([given, fam].filter(Boolean).join(" "));
      }
    }
    return { id: str(get(r, "id")), name: name, birthDate: date(get(r, "birthDate")), gender: str(get(r, "gender")) };
  }

  function condition(r) {
    return {
      id: str(get(r, "id")),
      text: ccText(get(r, "code")),
      codes: codings(get(r, "code")),
      clinicalStatus: firstCode(get(r, "clinicalStatus")),
      verificationStatus: firstCode(get(r, "verificationStatus")),
      category: arr(get(r, "category")).map(ccText).filter(Boolean),
      onset: dateOf(r, "onset") || str(get(r, "onsetString")),
      abatement: dateOf(r, "abatement"),
      recorded: date(get(r, "recordedDate")) || date(get(r, "dateRecorded")),
      date: dateOf(r, "onset") || date(get(r, "recordedDate")) || date(get(r, "dateRecorded"))
    };
  }

  function medStatement(r, meds) {
    var m = medicationName(r, meds);
    return {
      id: str(get(r, "id")), kind: "statement", text: m.text, codes: m.codes,
      status: str(get(r, "status")),
      date: dateOf(r, "effective") || date(get(r, "dateAsserted")),
      dosage: dosageText(r, "dosage")
    };
  }
  function medRequest(r, meds) {
    var m = medicationName(r, meds);
    return {
      id: str(get(r, "id")), kind: "request", text: m.text, codes: m.codes,
      status: str(get(r, "status")), intent: str(get(r, "intent")),
      date: date(get(r, "authoredOn")),
      dosage: dosageText(r, "dosageInstruction")
    };
  }
  function immunization(r) {
    return {
      id: str(get(r, "id")),
      text: ccText(get(r, "vaccineCode")),
      codes: codings(get(r, "vaccineCode")),
      status: str(get(r, "status")),
      date: date(get(r, "occurrenceDateTime")) || date(get(r, "date")) || null, // "date" is the DSTU2 name
      dateText: str(get(r, "occurrenceString")),
      lotNumber: str(get(r, "lotNumber")),
      performer: arr(get(r, "performer")).map(function (p) { return refDisplay(get(p, "actor")); }).filter(Boolean)[0] || null
    };
  }
  function allergy(r) {
    var code = get(r, "code") || get(r, "substance"); // "substance" is the DSTU2 name
    var rx = arr(get(r, "reaction")), reactions = [];
    for (var i = 0; i < rx.length && i < 20; i++) {
      var ms = arr(get(rx[i], "manifestation")).map(ccText).filter(Boolean);
      reactions.push({ manifestations: ms, severity: str(get(rx[i], "severity")) });
    }
    return {
      id: str(get(r, "id")),
      text: ccText(code),
      codes: codings(code),
      clinicalStatus: firstCode(get(r, "clinicalStatus")) || str(get(r, "status")),
      verificationStatus: firstCode(get(r, "verificationStatus")),
      type: str(get(r, "type")),
      category: arr(get(r, "category")).map(str).filter(Boolean),
      criticality: str(get(r, "criticality")),
      onset: dateOf(r, "onset"),
      recorded: date(get(r, "recordedDate")),
      date: dateOf(r, "onset") || date(get(r, "recordedDate")),
      reactions: reactions
    };
  }

  function range(rr) {
    var out = [], list = arr(rr);
    for (var i = 0; i < list.length && i < 10; i++) {
      var x = list[i];
      if (!x || typeof x !== "object") continue;
      var lo = quantity(get(x, "low")), hi = quantity(get(x, "high"));
      out.push({ low: lo ? lo.value : null, high: hi ? hi.value : null, unit: (lo && lo.unit) || (hi && hi.unit) || null, text: str(get(x, "text")), appliesTo: arr(get(x, "appliesTo")).map(ccText).filter(Boolean) });
    }
    return out;
  }
  // Position relative to the lab's own range only; no other interpretation.
  function position(value, unit, ranges) {
    if (value === null || !ranges.length) return null;
    var r = ranges[0];
    if (r.low === null && r.high === null) return null;
    if (r.unit && unit && r.unit !== unit) return null; // units differ: do not compare
    if (r.low !== null && value < r.low) return "below";
    if (r.high !== null && value > r.high) return "above";
    return "within";
  }

  function observation(r) {
    var cats = arr(get(r, "category"));
    var catCodes = [];
    for (var i = 0; i < cats.length; i++) { var cs = codings(cats[i]); for (var j = 0; j < cs.length; j++) if (cs[j].code) catCodes.push(cs[j].code); }
    var kind = catCodes.indexOf("laboratory") >= 0 ? "lab" : (catCodes.indexOf("vital-signs") >= 0 ? "vital" : "other");
    var q = quantity(get(r, "valueQuantity"));
    var ranges = range(get(r, "referenceRange"));
    var comps = [], cl = arr(get(r, "component"));
    for (i = 0; i < cl.length && i < 20; i++) {
      var c = cl[i], cq = quantity(get(c, "valueQuantity")), crr = range(get(c, "referenceRange"));
      comps.push({
        loinc: codeIn(get(c, "code"), LOINC), name: ccText(get(c, "code")),
        value: cq ? cq.value : null, unit: cq ? cq.unit : null,
        valueText: str(get(c, "valueString")) || ccText(get(c, "valueCodeableConcept")),
        referenceRange: crr, position: position(cq ? cq.value : null, cq ? cq.unit : null, crr)
      });
    }
    var vt = str(get(r, "valueString")) || ccText(get(r, "valueCodeableConcept"));
    if (!vt && typeof get(r, "valueBoolean") === "boolean") vt = r.valueBoolean ? "true" : "false";
    if (!vt && num(get(r, "valueInteger")) !== null) q = { value: r.valueInteger, unit: null, code: null, comparator: null };
    return {
      id: str(get(r, "id")),
      kind: kind,
      category: catCodes,
      status: str(get(r, "status")),
      loinc: codeIn(get(r, "code"), LOINC),
      codes: codings(get(r, "code")),
      name: ccText(get(r, "code")),
      value: q ? q.value : null,
      unit: q ? q.unit : null,
      comparator: q ? q.comparator : null,
      valueText: vt,
      dataAbsent: ccText(get(r, "dataAbsentReason")),
      referenceRange: ranges,
      position: position(q ? q.value : null, q ? q.unit : null, ranges),
      date: dateOf(r, "effective") || date(get(r, "issued")),
      components: comps
    };
  }

  // ------------------------------------------------------------ walk
  var SKIP_STATUS = { "entered-in-error": 1, "cancelled": 1 };

  // Collect resources from a Bundle (nested Bundles included), a single
  // resource, an array of either, or a { entry: [...] } shaped object.
  function collect(data, out, depth) {
    if (depth > 8 || out.length > MAX_RESOURCES) return;
    if (Array.isArray(data)) { for (var i = 0; i < data.length; i++) collect(data[i], out, depth + 1); return; }
    if (!data || typeof data !== "object") return;
    var rt = get(data, "resourceType");
    if (rt === "Bundle" || (rt === undefined && Array.isArray(get(data, "entry")))) {
      var es = arr(get(data, "entry"));
      for (var k = 0; k < es.length; k++) {
        var res = get(es[k], "resource");
        if (res) collect(res, out, depth + 1);
      }
      return;
    }
    if (typeof rt === "string") out.push({ r: data, fullUrl: null });
  }

  function emptyResult() {
    return { patient: null, conditions: [], medications: [], immunizations: [], allergies: [], observations: [], skipped: {}, warnings: [], counts: {} };
  }

  function extract(data, result) {
    var list = [];
    collect(data, list, 0);
    if (list.length > MAX_RESOURCES) result.warnings.push("Only the first " + MAX_RESOURCES + " resources were read.");
    var meds = new Map();
    for (var i = 0; i < list.length; i++) {
      var r = list[i].r;
      if (get(r, "resourceType") === "Medication" && str(get(r, "id"))) meds.set("Medication/" + str(r.id), r);
    }
    for (i = 0; i < list.length && i < MAX_RESOURCES; i++) {
      r = list[i].r;
      var rt = get(r, "resourceType");
      if (typeof rt !== "string") continue;
      var st = str(get(r, "status"));
      if (st && Object.prototype.hasOwnProperty.call(SKIP_STATUS, st)) { bump(result.skipped, rt + " (" + st + ")"); continue; }
      var vs = firstCode(get(r, "verificationStatus"));
      if (vs === "entered-in-error") { bump(result.skipped, rt + " (entered-in-error)"); continue; }
      switch (rt) {
        case "Patient": if (!result.patient) result.patient = patient(r); break;
        case "Condition": result.conditions.push(condition(r)); break;
        case "MedicationStatement": result.medications.push(medStatement(r, meds)); break;
        case "MedicationRequest": result.medications.push(medRequest(r, meds)); break;
        case "Immunization": result.immunizations.push(immunization(r)); break;
        case "AllergyIntolerance": result.allergies.push(allergy(r)); break;
        case "Observation": result.observations.push(observation(r)); break;
        case "Medication": break;
        default: bump(result.skipped, rt.slice(0, 60));
      }
    }
    result.counts = { conditions: result.conditions.length, medications: result.medications.length, immunizations: result.immunizations.length, allergies: result.allergies.length, observations: result.observations.length };
    return result;
  }
  function bump(o, k) { o[k] = (own(o, k) ? o[k] : 0) + 1; }

  // Parse one file (text or parsed JSON). Several files: call parseMany.
  function parse(input) { return extract(parseJson(input), emptyResult()); }

  function parseMany(inputs) {
    if (!Array.isArray(inputs)) throw err("input", "Expected a list of files.");
    var res = emptyResult(), all = [];
    for (var i = 0; i < inputs.length; i++) {
      try { all.push(parseJson(inputs[i])); }
      catch (e) { res.warnings.push("File " + (i + 1) + ": " + e.message); }
    }
    return extract(all, res);
  }

  // Dated events for a timeline, oldest first. Undated items come last.
  function timeline(result) {
    var ev = [];
    function add(type, list, label) {
      for (var i = 0; i < list.length; i++) ev.push({ type: type, date: list[i].date || null, label: label(list[i]), item: list[i] });
    }
    add("condition", result.conditions, function (x) { return x.text; });
    add("medication", result.medications, function (x) { return x.text; });
    add("immunization", result.immunizations, function (x) { return x.text; });
    add("allergy", result.allergies, function (x) { return x.text; });
    add("observation", result.observations, function (x) { return x.name; });
    ev.sort(function (a, b) {
      if (a.date === b.date) return 0;
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return a.date < b.date ? -1 : 1;
    });
    return ev;
  }

  // Group numeric lab observations by LOINC (or name) for trend charts.
  function labSeries(observations) {
    var groups = new Map();
    for (var i = 0; i < observations.length; i++) {
      var o = observations[i];
      if (o.value === null || !o.date) continue;
      var key = o.loinc ? "loinc:" + o.loinc : (o.name ? "name:" + o.name.toLowerCase() : null);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { key: key, loinc: o.loinc, name: o.name, unit: o.unit, points: [] });
      var g = groups.get(key);
      if (g.unit && o.unit && g.unit !== o.unit) { g.mixedUnits = true; continue; }
      g.points.push({ date: o.date, value: o.value, unit: o.unit, low: o.referenceRange.length ? o.referenceRange[0].low : null, high: o.referenceRange.length ? o.referenceRange[0].high : null, position: o.position });
    }
    var out = [];
    groups.forEach(function (g) { g.points.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); }); out.push(g); });
    out.sort(function (a, b) { return (a.name || "") < (b.name || "") ? -1 : 1; });
    return out;
  }

  // ------------------------------------------------------------ SMART Health Cards
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function b64urlDecode(s) {
    if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw err("shc", "Not base64url data.");
    if (s.length % 4 === 1) throw err("shc", "Base64url data has an impossible length.");
    var out = [], buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      buf = (buf << 6) | B64.indexOf(s.charAt(i)); bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xFF); }
      buf &= 0xFFFF;
    }
    return out;
  }
  // Strict-enough UTF-8 decoder (TextDecoder is not assumed to exist).
  function utf8(bytes) {
    var s = "", i = 0, n = bytes.length;
    while (i < n) {
      var b = bytes[i++], cp;
      if (b < 0x80) cp = b;
      else if (b >= 0xC2 && b < 0xE0 && i < n && (bytes[i] & 0xC0) === 0x80) cp = ((b & 0x1F) << 6) | (bytes[i++] & 0x3F);
      else if (b >= 0xE0 && b < 0xF0 && i + 1 < n && (bytes[i] & 0xC0) === 0x80 && (bytes[i + 1] & 0xC0) === 0x80) {
        cp = ((b & 0x0F) << 12) | ((bytes[i] & 0x3F) << 6) | (bytes[i + 1] & 0x3F); i += 2;
        if (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
      } else if (b >= 0xF0 && b < 0xF5 && i + 2 < n && (bytes[i] & 0xC0) === 0x80 && (bytes[i + 1] & 0xC0) === 0x80 && (bytes[i + 2] & 0xC0) === 0x80) {
        cp = ((b & 0x07) << 18) | ((bytes[i] & 0x3F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F); i += 3;
        if (cp < 0x10000 || cp > 0x10FFFF) cp = 0xFFFD;
      } else cp = 0xFFFD;
      s += String.fromCodePoint(cp);
      if (s.length > MAX_TEXT) throw err("size", "Decoded payload is too large.");
    }
    return s;
  }
  function toArray(bytes) {
    if (Array.isArray(bytes)) return bytes;
    if (bytes && ArrayBuffer.isView(bytes)) { var a = []; var u = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength); for (var i = 0; i < u.length; i++) a.push(u[i]); return a; }
    if (Object.prototype.toString.call(bytes) === "[object ArrayBuffer]") return toArray(new Uint8Array(bytes));
    throw err("shc", "The inflate function must return bytes.");
  }

  // shc:/ numeric QR content -> compact JWS. Each pair of digits is
  // (character code - 45). Chunked ("shc:/1/2/...") codes are not supported.
  function shcNumericToJws(s) {
    var m = /^shc:\/(\d+)$/.exec(s.trim());
    if (!m) throw err("shc", "Not a single-chunk shc:/ code.");
    var d = m[1];
    if (d.length % 2) throw err("shc", "The shc:/ digits have an odd length.");
    var out = "";
    for (var i = 0; i < d.length; i += 2) {
      var v = parseInt(d.substr(i, 2), 10);
      if (v > 77) throw err("shc", "The shc:/ code has an invalid digit pair.");
      out += String.fromCharCode(v + 45);
    }
    return out;
  }

  // Decode a SMART Health Card. input: "shc:/..." text, a compact JWS, or a
  // .smart-health-card file ({ verifiableCredential: [jws, ...] }).
  // inflateRaw(bytes) -> bytes must do raw DEFLATE (RFC 1951) decompression;
  // the caller supplies it (for example DecompressionStream("deflate-raw")
  // in the browser, wrapped to be synchronous, or zlib.inflateRawSync in node).
  // The signature is NOT verified here; every result says so.
  function decodeHealthCard(input, inflateRaw) {
    var jwsList = [];
    if (typeof input === "string") {
      var t = input.trim();
      if (t.length > MAX_TEXT) throw err("size", "The card is too large.");
      if (/^shc:\//.test(t)) jwsList.push(shcNumericToJws(t));
      else if (t.charAt(0) === "{") {
        var file = parseJson(t);
        jwsList = arr(get(file, "verifiableCredential"));
      } else jwsList.push(t);
    } else if (input && typeof input === "object") {
      jwsList = arr(get(sanitize(input), "verifiableCredential"));
    } else throw err("shc", "Expected a SMART Health Card.");
    if (!jwsList.length) throw err("shc", "No credentials found.");
    if (jwsList.length > 50) throw err("size", "Too many credentials in one file.");
    var cards = [];
    for (var i = 0; i < jwsList.length; i++) cards.push(decodeJws(jwsList[i], inflateRaw));
    return cards.length === 1 ? cards[0] : { cards: cards, signature: "unverified", verified: false };
  }

  function decodeJws(jws, inflateRaw) {
    if (typeof jws !== "string") throw err("shc", "A credential is not a JWS string.");
    var parts = jws.split(".");
    if (parts.length !== 3) throw err("shc", "A JWS has three dot-separated parts.");
    var header;
    try { header = sanitize(JSON.parse(utf8(b64urlDecode(parts[0])))); } catch (e) { throw err("shc", "The JWS header is not valid."); }
    if (!header || typeof header !== "object" || Array.isArray(header)) throw err("shc", "The JWS header is not an object.");
    var bytes = b64urlDecode(parts[1]);
    if (get(header, "zip") === "DEF") {
      if (typeof inflateRaw !== "function") throw err("inflate", "This card is compressed; an inflate function is required.");
      var out;
      try { out = inflateRaw(new Uint8Array(bytes)); } catch (e) { throw err("shc", "The card payload could not be decompressed."); }
      bytes = toArray(out);
      if (bytes.length > 5 * 1024 * 1024) throw err("size", "The decompressed card is too large.");
    } else if (get(header, "zip") !== undefined) throw err("shc", "Unknown JWS compression.");
    var payload;
    try { payload = parseJson(utf8(bytes)); } catch (e) { throw err("shc", "The card payload is not valid JSON."); }
    var vc = get(payload, "vc"), subj = get(vc, "credentialSubject");
    var bundle = get(subj, "fhirBundle");
    var types = arr(get(vc, "type")).map(str).filter(Boolean);
    var nbf = num(get(payload, "nbf"));
    var issued = null;
    if (nbf !== null && nbf > 0 && nbf < 1e11) {
      // Seconds since 1970 -> ISO date-time (UTC), computed without Date().
      issued = isoFromEpoch(Math.floor(nbf));
    }
    return {
      issuer: str(get(payload, "iss")),
      issued: issued,
      types: types,
      isHealthCard: types.indexOf("https://smarthealth.cards#health-card") >= 0,
      fhirVersion: str(get(subj, "fhirVersion")),
      header: { alg: str(get(header, "alg")), kid: str(get(header, "kid")), zip: str(get(header, "zip")) },
      records: bundle ? extract(bundle, emptyResult()) : emptyResult(),
      signature: "unverified",
      verified: false
    };
  }

  function isoFromEpoch(sec) {
    var days = Math.floor(sec / 86400), rem = sec - days * 86400;
    var z = days + 719468, era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
    var doe = z - era * 146097, yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400, doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp + (mp < 10 ? 3 : -9);
    if (m <= 2) y++;
    function p(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
    return p(y, 4) + "-" + p(m, 2) + "-" + p(d, 2) + "T" + p(Math.floor(rem / 3600), 2) + ":" + p(Math.floor(rem % 3600 / 60), 2) + ":" + p(rem % 60, 2) + "Z";
  }

  return Object.freeze({
    sanitize: sanitize,
    parse: parse,
    parseMany: parseMany,
    timeline: timeline,
    labSeries: labSeries,
    decodeHealthCard: decodeHealthCard,
    shcNumericToJws: shcNumericToJws,
    base64urlDecode: b64urlDecode,
    utf8Decode: utf8
  });
})();
