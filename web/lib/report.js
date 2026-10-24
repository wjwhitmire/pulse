// PulseReport: clinician report data, a FHIR R4 Bundle and a plain-text
// summary built from the app's daily metrics. Pure functions. The report
// lists self-recorded numbers and trends only. It contains no diagnosis,
// interpretation or advice wording.
var PulseReport = (function () {
  "use strict";

  var MAX_DAYS = 3660;
  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function own(o, k) { return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k); }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

  // ------------------------------------------------------------ dates
  function fdiv(a, b) { return Math.floor(a / b); }
  function daysFromCivil(y, m, d) {
    y -= m <= 2 ? 1 : 0;
    var era = fdiv(y >= 0 ? y : y - 399, 400), yoe = y - era * 400;
    var doy = fdiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;
    return era * 146097 + yoe * 365 + fdiv(yoe, 4) - fdiv(yoe, 100) + doy - 719468;
  }
  function civilFromDays(z) {
    z += 719468;
    var era = fdiv(z >= 0 ? z : z - 146096, 146097), doe = z - era * 146097;
    var yoe = fdiv(doe - fdiv(doe, 1460) + fdiv(doe, 36524) - fdiv(doe, 146096), 365);
    var doy = doe - (365 * yoe + fdiv(yoe, 4) - fdiv(yoe, 100)), mp = fdiv(5 * doy + 2, 153);
    var d = doy - fdiv(153 * mp + 2, 5) + 1, m = mp + (mp < 10 ? 3 : -9);
    return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
  }
  function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
  function dayStr(z) { var c = civilFromDays(z); return pad(c[0], 4) + "-" + pad(c[1], 2) + "-" + pad(c[2], 2); }
  function parseDay(v) {
    if (typeof v === "number" && isFinite(v) && Math.floor(v) === v && Math.abs(v) < 1e7) return v; // day number (days since 1970-01-01)
    var m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var z = daysFromCivil(y, mo, d);
    return dayStr(z) === m[0] ? z : null;
  }

  // ------------------------------------------------------------ metrics
  // key: field in the daily rows; range: plausible bounds, rows outside are skipped.
  var METRICS = [
    { key: "rhr", label: "Resting heart rate", unit: "bpm", ucum: "/min", decimals: 0, range: [20, 150],
      loinc: { code: "40443-4", display: "Heart rate --resting" }, category: "vital-signs" },
    { key: "rmssd", label: "Heart rate variability (RMSSD)", unit: "ms", ucum: "ms", decimals: 1, range: [1, 400],
      loinc: null, text: "Heart rate variability, RMSSD (self-recorded)", category: "vital-signs" },
    { key: "sdnn", label: "Heart rate variability (SDNN)", unit: "ms", ucum: "ms", decimals: 1, range: [1, 400],
      loinc: { code: "80404-7", display: "R-R interval.standard deviation (Heart rate variability)" }, category: "vital-signs" },
    { key: "sleep", label: "Sleep duration", unit: "h", ucum: "h", decimals: 2, range: [0, 20],
      loinc: { code: "93832-4", display: "Sleep duration" }, category: "activity" },
    { key: "weight", label: "Body weight", unit: "kg", ucum: "kg", decimals: 1, range: [20, 400],
      loinc: { code: "29463-7", display: "Body weight" }, category: "vital-signs" }
  ];
  var BP = { panel: { code: "85354-9", display: "Blood pressure panel with all children optional" },
    sys: { code: "8480-6", display: "Systolic blood pressure" }, dia: { code: "8462-4", display: "Diastolic blood pressure" } };

  function round(v, d) { var f = Math.pow(10, d); return Math.round(v * f) / f; }
  function stats(vals) {
    if (!vals.length) return null;
    var s = 0, mn = Infinity, mx = -Infinity;
    for (var i = 0; i < vals.length; i++) { s += vals[i]; mn = Math.min(mn, vals[i]); mx = Math.max(mx, vals[i]); }
    return { n: vals.length, mean: s / vals.length, min: mn, max: mx };
  }

  // Normalize rows: one per day, later rows for the same day fill gaps only.
  function normalize(daily, opts) {
    if (!Array.isArray(daily)) throw err("input", "Daily metrics must be an array.");
    if (daily.length > 100000) throw err("size", "Too many daily rows.");
    var from = own(opts, "from") ? parseDay(opts.from) : null, to = own(opts, "to") ? parseDay(opts.to) : null;
    var byDay = new Map(), skipped = 0;
    for (var i = 0; i < daily.length; i++) {
      var r = daily[i];
      if (!r || typeof r !== "object") { skipped++; continue; }
      var z = parseDay(r.date);
      if (z === null) { skipped++; continue; }
      if ((from !== null && z < from) || (to !== null && z > to)) continue;
      var row = byDay.get(z) || { z: z };
      for (var m = 0; m < METRICS.length; m++) {
        var M = METRICS[m], v = num(own(r, M.key) ? r[M.key] : null);
        if (v !== null && v >= M.range[0] && v <= M.range[1] && row[M.key] === undefined) row[M.key] = v;
        else if (v !== null && !(v >= M.range[0] && v <= M.range[1])) skipped++;
      }
      var sys = num(own(r, "sys") ? r.sys : null), dia = num(own(r, "dia") ? r.dia : null);
      if (sys !== null && dia !== null && sys >= 50 && sys <= 300 && dia >= 20 && dia <= 200 && sys > dia && row.sys === undefined) { row.sys = sys; row.dia = dia; }
      else if (sys !== null || dia !== null) { if (row.sys === undefined) skipped++; }
      byDay.set(z, row);
    }
    var days = Array.from(byDay.keys()).sort(function (a, b) { return a - b; });
    if (days.length > MAX_DAYS) days = days.slice(-MAX_DAYS);
    return { rows: days.map(function (z) { return byDay.get(z); }), skipped: skipped, from: from, to: to };
  }

  function seriesSummary(rows, key, decimals) {
    var vals = [], dated = [];
    for (var i = 0; i < rows.length; i++) if (rows[i][key] !== undefined) { vals.push(rows[i][key]); dated.push(rows[i]); }
    var st = stats(vals);
    if (!st) return null;
    var first = stats(vals.slice(0, Math.min(7, vals.length))), last = stats(vals.slice(-Math.min(7, vals.length)));
    // Weekly means (weeks start on Monday; 1970-01-05 was a Monday).
    var weeks = new Map();
    for (i = 0; i < dated.length; i++) {
      var wk = dated[i].z - (((dated[i].z - 4) % 7) + 7) % 7;
      if (!weeks.has(wk)) weeks.set(wk, []);
      weeks.get(wk).push(dated[i][key]);
    }
    var weekly = [];
    weeks.forEach(function (v, wk) { var s = stats(v); weekly.push({ weekStart: dayStr(wk), mean: round(s.mean, decimals), n: s.n }); });
    weekly.sort(function (a, b) { return a.weekStart < b.weekStart ? -1 : 1; });
    var lastRow = dated[dated.length - 1];
    return {
      n: st.n, mean: round(st.mean, decimals), min: round(st.min, decimals), max: round(st.max, decimals),
      firstWeekMean: round(first.mean, decimals), lastWeekMean: round(last.mean, decimals),
      latest: { date: dayStr(lastRow.z), value: round(lastRow[key], decimals) },
      weekly: weekly
    };
  }

  function cleanText(v, max) {
    if (typeof v !== "string") return null;
    var s = v.replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
    return s ? s.slice(0, max || 300) : null;
  }

  // Build the report data object. opts: from, to (YYYY-MM-DD), generated
  // (ISO date-time string supplied by the caller), patient { name, birthDate },
  // labs (PulseFHIR observations the user chose), medications (PulseFHIR
  // medications the user chose), include { rhr, rmssd, sdnn, sleep, weight, bp }.
  function buildReport(daily, opts) {
    var o = opts && typeof opts === "object" ? opts : {};
    var norm = normalize(daily, o);
    var rows = norm.rows, inc = own(o, "include") && o.include && typeof o.include === "object" ? o.include : null;
    function on(k) { return !inc || inc[k] !== false; }
    var metrics = [];
    for (var m = 0; m < METRICS.length; m++) {
      var M = METRICS[m];
      if (!on(M.key)) continue;
      var s = seriesSummary(rows, M.key, M.decimals);
      if (s) { s.key = M.key; s.label = M.label; s.unit = M.unit; metrics.push(s); }
    }
    var bp = null;
    if (on("bp")) {
      var sysS = seriesSummary(rows, "sys", 0), diaS = seriesSummary(rows, "dia", 0);
      if (sysS && diaS) bp = { label: "Blood pressure", unit: "mmHg", n: sysS.n, systolic: sysS, diastolic: diaS, latest: { date: sysS.latest.date, systolic: sysS.latest.value, diastolic: diaS.latest.value } };
    }
    var labs = [];
    if (Array.isArray(o.labs)) for (var i = 0; i < o.labs.length && i < 2000; i++) {
      var L = o.labs[i];
      if (!L || typeof L !== "object") continue;
      var lv = num(L.value);
      var rr = Array.isArray(L.referenceRange) && L.referenceRange[0] ? L.referenceRange[0] : null;
      labs.push({ name: cleanText(L.name), loinc: cleanText(L.loinc, 20), value: lv, unit: cleanText(L.unit, 40), valueText: cleanText(L.valueText),
        date: cleanText(L.date, 40), rangeLow: rr ? num(rr.low) : null, rangeHigh: rr ? num(rr.high) : null, rangeText: rr ? cleanText(rr.text) : null });
    }
    var meds = [];
    if (Array.isArray(o.medications)) for (i = 0; i < o.medications.length && i < 500; i++) {
      var md = o.medications[i];
      if (!md || typeof md !== "object" || !cleanText(md.text)) continue;
      meds.push({ text: cleanText(md.text), dosage: cleanText(md.dosage), status: cleanText(md.status, 40), date: cleanText(md.date, 40) });
    }
    var first = rows.length ? rows[0].z : null, last = rows.length ? rows[rows.length - 1].z : null;
    var p = own(o, "patient") && o.patient && typeof o.patient === "object" ? o.patient : {};
    return {
      title: "Self-recorded health summary",
      generated: typeof o.generated === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(o.generated) ? o.generated : null,
      patient: { name: cleanText(p.name, 120), birthDate: parseDay(p.birthDate) !== null ? dayStr(parseDay(p.birthDate)) : null },
      period: { from: norm.from !== null ? dayStr(norm.from) : (first !== null ? dayStr(first) : null), to: norm.to !== null ? dayStr(norm.to) : (last !== null ? dayStr(last) : null), daysWithData: rows.length },
      metrics: metrics,
      bloodPressure: bp,
      labs: labs,
      medications: meds,
      skippedValues: norm.skipped,
      notes: [
        "Values were recorded by the user with consumer devices and the Pulse app.",
        "Pulse lists the numbers and their averages. It does not interpret them.",
        "Lab values and reference ranges are shown as reported by the lab."
      ],
      _rows: rows
    };
  }

  // ------------------------------------------------------------ FHIR
  function fnv(s, seed) {
    var h = (0x811c9dc5 ^ seed) >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  // Deterministic UUID (version 4 layout) from content, so the same report
  // produces the same Bundle and no randomness source is needed.
  function uuidFrom(s) {
    var hex = "";
    for (var k = 0; k < 4; k++) hex += pad(fnv(s, k * 0x9E3779B9).toString(16), 8);
    var c = hex.split("");
    c[12] = "4";
    c[16] = "89ab".charAt(parseInt(c[16], 16) & 3);
    hex = c.join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
  }
  var CAT = "http://terminology.hl7.org/CodeSystem/observation-category";
  var UCUM = "http://unitsofmeasure.org";
  function category(code) { return [{ coding: [{ system: CAT, code: code, display: code === "vital-signs" ? "Vital Signs" : "Activity" }] }]; }
  function qty(v, unit, ucum) { return { value: v, unit: unit, system: UCUM, code: ucum }; }

  function toFhirBundle(report) {
    if (!report || !Array.isArray(report._rows)) throw err("input", "Pass the object returned by buildReport.");
    var entries = [], seed = JSON.stringify([report.period, report.generated, report.patient]);
    var patientUrl = "urn:uuid:" + uuidFrom("patient|" + seed);
    var pat = { resourceType: "Patient" };
    if (report.patient.name) pat.name = [{ text: report.patient.name }];
    if (report.patient.birthDate) pat.birthDate = report.patient.birthDate;
    entries.push({ fullUrl: patientUrl, resource: pat });
    var subject = { reference: patientUrl };
    var keys = report.metrics.map(function (m) { return m.key; });
    var rows = report._rows;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], date = dayStr(r.z);
      for (var m = 0; m < METRICS.length; m++) {
        var M = METRICS[m];
        if (keys.indexOf(M.key) < 0 || r[M.key] === undefined) continue;
        var code = M.loinc ? { coding: [{ system: "http://loinc.org", code: M.loinc.code, display: M.loinc.display }], text: M.label } : { text: M.text };
        entries.push({ fullUrl: "urn:uuid:" + uuidFrom(M.key + "|" + date + "|" + seed), resource: {
          resourceType: "Observation", status: "final", category: category(M.category), code: code, subject: subject,
          effectiveDateTime: date, valueQuantity: qty(round(r[M.key], M.decimals), M.unit, M.ucum)
        } });
      }
      if (report.bloodPressure && r.sys !== undefined) {
        entries.push({ fullUrl: "urn:uuid:" + uuidFrom("bp|" + date + "|" + seed), resource: {
          resourceType: "Observation", status: "final", category: category("vital-signs"),
          code: { coding: [{ system: "http://loinc.org", code: BP.panel.code, display: BP.panel.display }], text: "Blood pressure" },
          subject: subject, effectiveDateTime: date,
          component: [
            { code: { coding: [{ system: "http://loinc.org", code: BP.sys.code, display: BP.sys.display }] }, valueQuantity: qty(r.sys, "mmHg", "mm[Hg]") },
            { code: { coding: [{ system: "http://loinc.org", code: BP.dia.code, display: BP.dia.display }] }, valueQuantity: qty(r.dia, "mmHg", "mm[Hg]") }
          ]
        } });
      }
    }
    for (i = 0; i < report.labs.length; i++) {
      var L = report.labs[i];
      if (L.value === null && !L.valueText) continue;
      var obs = { resourceType: "Observation", status: "final", category: [{ coding: [{ system: CAT, code: "laboratory", display: "Laboratory" }] }],
        code: L.loinc ? { coding: [{ system: "http://loinc.org", code: L.loinc }], text: L.name || L.loinc } : { text: L.name || "Lab result" }, subject: subject };
      if (L.date && /^\d{4}(-\d{2}(-\d{2})?)?/.test(L.date)) obs.effectiveDateTime = L.date;
      if (L.value !== null) obs.valueQuantity = L.unit ? { value: L.value, unit: L.unit } : { value: L.value };
      else obs.valueString = L.valueText;
      if (L.rangeLow !== null || L.rangeHigh !== null || L.rangeText) {
        var rr = {};
        if (L.rangeLow !== null) rr.low = L.unit ? { value: L.rangeLow, unit: L.unit } : { value: L.rangeLow };
        if (L.rangeHigh !== null) rr.high = L.unit ? { value: L.rangeHigh, unit: L.unit } : { value: L.rangeHigh };
        if (L.rangeText) rr.text = L.rangeText;
        obs.referenceRange = [rr];
      }
      entries.push({ fullUrl: "urn:uuid:" + uuidFrom("lab|" + i + "|" + JSON.stringify(L) + seed), resource: obs });
    }
    for (i = 0; i < report.medications.length; i++) {
      var md = report.medications[i];
      var ms = { resourceType: "MedicationStatement", status: ["active", "completed", "entered-in-error", "intended", "stopped", "on-hold", "unknown", "not-taken"].indexOf(md.status) >= 0 ? md.status : "unknown",
        medicationCodeableConcept: { text: md.text }, subject: subject };
      if (md.date && /^\d{4}(-\d{2}(-\d{2})?)?/.test(md.date)) ms.effectiveDateTime = md.date;
      if (md.dosage) ms.dosage = [{ text: md.dosage }];
      entries.push({ fullUrl: "urn:uuid:" + uuidFrom("med|" + i + "|" + md.text + seed), resource: ms });
    }
    var bundle = { resourceType: "Bundle", identifier: { system: "urn:ietf:rfc:3986", value: "urn:uuid:" + uuidFrom("bundle|" + seed + entries.length) }, type: "collection" };
    if (report.generated) bundle.timestamp = report.generated;
    bundle.entry = entries;
    return bundle;
  }

  // ------------------------------------------------------------ text
  function fmt(v, d) { return v === null || v === undefined ? "n/a" : (d ? v.toFixed(d) : String(Math.round(v))); }
  function summaryText(report) {
    if (!report || !Array.isArray(report.metrics)) throw err("input", "Pass the object returned by buildReport.");
    var L = [];
    L.push(report.title);
    if (report.patient.name) L.push("Name: " + report.patient.name);
    if (report.patient.birthDate) L.push("Date of birth: " + report.patient.birthDate);
    L.push("Period: " + (report.period.from || "n/a") + " to " + (report.period.to || "n/a") + " (" + report.period.daysWithData + " days with data)");
    if (report.generated) L.push("Prepared: " + report.generated);
    L.push("");
    if (!report.metrics.length && !report.bloodPressure) L.push("No measurements in this period.");
    for (var i = 0; i < report.metrics.length; i++) {
      var m = report.metrics[i], M = METRICS.filter(function (x) { return x.key === m.key; })[0], d = M.decimals ? Math.min(M.decimals, 1) : 0;
      L.push(m.label + " (" + m.unit + "): mean " + fmt(m.mean, d) + ", range " + fmt(m.min, d) + " to " + fmt(m.max, d) + ", " + m.n + " days. First week mean " + fmt(m.firstWeekMean, d) + ", last week mean " + fmt(m.lastWeekMean, d) + ". Latest " + fmt(m.latest.value, d) + " on " + m.latest.date + ".");
    }
    var bp = report.bloodPressure;
    if (bp) L.push("Blood pressure (mmHg): mean " + fmt(bp.systolic.mean) + "/" + fmt(bp.diastolic.mean) + ", " + bp.n + " days. Latest " + bp.latest.systolic + "/" + bp.latest.diastolic + " on " + bp.latest.date + ".");
    if (report.labs.length) {
      L.push(""); L.push("Lab results (as reported by the lab):");
      for (i = 0; i < report.labs.length; i++) {
        var x = report.labs[i], range = x.rangeLow !== null || x.rangeHigh !== null ? " (lab range " + (x.rangeLow !== null ? x.rangeLow : "") + " to " + (x.rangeHigh !== null ? x.rangeHigh : "") + ")" : (x.rangeText ? " (lab range " + x.rangeText + ")" : "");
        L.push("- " + (x.name || x.loinc || "Lab") + ": " + (x.value !== null ? x.value + (x.unit ? " " + x.unit : "") : (x.valueText || "n/a")) + range + (x.date ? ", " + x.date.slice(0, 10) : ""));
      }
    }
    if (report.medications.length) {
      L.push(""); L.push("Medications listed by the user:");
      for (i = 0; i < report.medications.length; i++) { var md = report.medications[i]; L.push("- " + md.text + (md.dosage ? ", " + md.dosage : "")); }
    }
    L.push("");
    for (i = 0; i < report.notes.length; i++) L.push(report.notes[i]);
    return L.join("\n");
  }

  return Object.freeze({
    METRICS: METRICS.map(function (m) { return { key: m.key, label: m.label, unit: m.unit, loinc: m.loinc ? m.loinc.code : null }; }),
    buildReport: buildReport,
    toFhirBundle: toFhirBundle,
    summaryText: summaryText,
    uuidFrom: uuidFrom
  });
})();
