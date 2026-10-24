// ---------------------------------------------------------------- decisions Pulse makes for you
// Settings Pulse can read from your own data are filled in automatically, each with a one-line
// reason shown in Settings. A value you type yourself is marked as yours and never replaced.
const AUTO_KEYS = ["max_hr", "rest_hr", "ftp", "threshold_speed", "weight_kg", "wake_min", "units"];
const MILE_REGIONS = ["US", "LR", "MM"];
function localeRegion() {
  const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""]);
  const m = /[-_]([A-Za-z]{2})\b/.exec(langs[0] || "");
  return m ? m[1].toUpperCase() : "";
}
// Estimates from the data already on this device. Returns {key: {value, why}} for what it can tell.
function autoEstimates() {
  const out = {}, c = context(), day = c.day;
  // Maximum heart rate: the highest per-activity maximum (values above 220 are treated as strap errors).
  let best = null;
  for (const m of APP.meta.values()) {
    const h = m.an && m.an.hr;
    if (h && h.max >= 120 && h.max <= 220 && (!best || h.max > best.v)) best = { v: h.max, day: m.day, name: m.name };
  }
  if (best) out.max_hr = { value: Math.round(best.v), why: "the highest heart rate in your activities (" + fmtDay(best.day) + ")" };
  // Resting heart rate: the mean of the last 60 days of resting HR readings, once there are 7.
  const rh = c.daily.filter((d) => d.date > day - 60 && d.date <= day && d.rhr >= 25 && d.rhr <= 110).map((d) => d.rhr);
  if (rh.length >= 7) out.rest_hr = { value: Math.round(SB.mean(rh)), why: "your average resting heart rate over " + rh.length + " days" };
  // FTP: 95 % of the best 20-minute power in the last 120 days (Allen and Coggan).
  let p20 = null;
  for (const m of APP.meta.values()) {
    const p = m.an && m.an.power && m.an.power.meanmax ? m.an.power.meanmax["1200"] : null;
    if (p && m.day > day - 120 && (!p20 || p > p20.v)) p20 = { v: p, day: m.day };
  }
  if (p20) out.ftp = { value: Math.round(0.95 * p20.v), why: "95 % of your best 20-minute power (" + fmtDay(p20.day) + "), after Allen and Coggan" };
  // Threshold pace: the speed you could hold for an hour, from your strongest run of 3 km or more in
  // the last 120 days, by Riegel's formula (distance in 60 minutes = d x (3600 / t)^(1 / 1.06)).
  let bestRun = null;
  for (const m of APP.meta.values()) {
    if (m.sport !== "run" || m.day <= day - 120 || !m.row || !m.row.fastest) continue;
    for (const [d, t] of m.row.fastest) {
      if (d === null || t === null || d < 3000 || !(t > 0)) continue;
      const v = SB.vdot(d, t);
      if (v !== null && (!bestRun || v > bestRun.vdot)) bestRun = { vdot: v, d, t, day: m.day };
    }
  }
  if (bestRun) {
    const d60 = bestRun.d * Math.pow(3600 / bestRun.t, 1 / 1.06);
    out.threshold_speed = { value: d60 / 3600, why: "the pace you could hold for an hour, from your best " + (bestRun.d / 1000).toFixed(bestRun.d % 1000 ? 1 : 0) + " km (" + fmtDay(bestRun.day) + ") by Riegel's formula" };
  }
  // Body weight: the latest weight in the body log or Health export from the last 30 days.
  const w = APP.kv.body.filter((b) => b.kg >= 30 && b.kg <= 250 && b.date > day - 30 && b.date <= day).sort((a, b) => a.date - b.date);
  if (w.length) out.weight_kg = { value: Math.round(w[w.length - 1].kg * 10) / 10, why: "your latest weight (" + fmtDay(w[w.length - 1].date) + ")" };
  // Wake time: the median wake time of the last 14 nights with one, rounded to 5 minutes.
  const wk = c.daily.filter((d) => d.date > day - 14 && d.date <= day && d.wake_min !== null && d.wake_min !== undefined).map((d) => d.wake_min).sort((a, b) => a - b);
  if (wk.length >= 3) out.wake_min = { value: Math.round(wk[wk.length >> 1] / 5) * 5, why: "your usual wake time over " + wk.length + " nights" };
  return out;
}
// Apply the estimates to settings the person has not set themselves. Returns true when anything changed.
async function applyAuto() {
  if (APP.example) return false;
  const est = autoEstimates(), s = Object.assign({}, APP.settings), notes = [];
  let changed = false;
  for (const k of ["max_hr", "rest_hr", "ftp", "threshold_speed", "weight_kg", "wake_min"]) {
    if (APP.kv.custom[k] || !est[k]) continue;
    // Max HR only ever goes up: most sessions are not maximal, so a lower maximum is not evidence.
    if (k === "max_hr" && est[k].value <= s.max_hr && !APP.kv.auto.max_hr) continue;
    const prev = s[k];
    s[k] = est[k].value;
    APP.kv.auto[k] = est[k];
    if (Math.abs(prev - s[k]) > (k === "threshold_speed" ? 0.005 : k === "weight_kg" ? 0.05 : 0.5)) { changed = true; notes.push(k); }
  }
  if (s.rest_hr >= s.max_hr - 20) { s.rest_hr = APP.settings.rest_hr; s.max_hr = APP.settings.max_hr; }
  await saveKv("auto");
  if (!changed) return false;
  APP.settings = SB.settingsWith(s);
  await saveKv("settings");
  logLine("Set from your data: " + notes.map((k) => AUTO_LABEL[k] + " " + autoValueText(k, s[k])).join(", ") + ". See Settings to change.", "good");
  await recomputeAll("Updated your zones from your data. Settings shows why.");
  return true;
}
const AUTO_LABEL = { max_hr: "maximum heart rate", rest_hr: "resting heart rate", ftp: "FTP", threshold_speed: "threshold pace", weight_kg: "body weight", wake_min: "wake time", units: "units" };
function autoValueText(k, v) {
  if (k === "weight_kg") return v.toFixed(1) + " kg";
  if (k === "wake_min") return SB.fmtClock(v);
  if (k === "threshold_speed") return fmtDur(1000 / v) + " /km";
  if (k === "ftp") return Math.round(v) + " W";
  if (k === "units") return v === "mi" ? "miles" : "kilometres";
  return Math.round(v) + " bpm";
}
// Units on first run: miles where the browser's region uses them, otherwise kilometres.
async function autoUnits(save) {
  if (APP.settingsSaved || APP.kv.custom.units) return;
  const reg = localeRegion(), mi = MILE_REGIONS.includes(reg);
  APP.settings = SB.settingsWith(Object.assign({}, APP.settings, { units: mi ? "mi" : "km" }));
  APP.kv.auto.units = { value: APP.settings.units, why: "your browser's region" + (reg ? " (" + reg + ")" : "") + (mi ? ", which uses miles" : ", which uses kilometres") };
  if (save === false) return;
  await saveKv("settings"); await saveKv("auto");
  APP.settingsSaved = true;
}
function renderAutoNote() {
  const node = $("auto-note");
  if (!node) return;
  clear(node);
  const items = AUTO_KEYS.filter((k) => APP.kv.auto[k] && !APP.kv.custom[k]);
  if (!items.length) { node.hidden = true; return; }
  node.hidden = false;
  node.append(el("p", { cls: "label", text: "Set from your data" }));
  const ul = el("ul", { cls: "rows" });
  for (const k of items) {
    const a = APP.kv.auto[k], field = k === "threshold_speed" ? "threshold_pace" : k === "wake_min" ? "wake" : k;
    const change = el("button", { type: "button", cls: "btn ghost", text: "Change", "aria-label": "Change " + AUTO_LABEL[k] });
    change.addEventListener("click", () => { const f = $("set-" + field); if (f) { f.scrollIntoView({ block: "center" }); f.focus(); } });
    ul.append(el("li", null, [el("span", { cls: "grow" }, [el("b", { text: AUTO_LABEL[k][0].toUpperCase() + AUTO_LABEL[k].slice(1) + ": " + autoValueText(k, APP.settings[k]) }), el("span", { cls: "sub", text: "From " + a.why + "." })]), change]));
  }
  node.append(ul);
}

// ---------------------------------------------------------------- one import for every file
// Pulse looks at each file and sends it to the right reader, so nobody has to know which of the
// eight file types they have. The separate pickers stay available under "Choose the file type".
async function sniffFile(f) {
  const name = f.name.toLowerCase();
  if (/\.(fit|gpx|tcx)$/.test(name)) return "activity";
  const head = new Uint8Array(await f.slice(0, 4096).arrayBuffer());
  if (head.length > 12 && head[8] === 0x2E && head[9] === 0x46 && head[10] === 0x49 && head[11] === 0x54) return "activity";
  if (head[0] === 0x50 && head[1] === 0x4B) {
    try {
      const names = (await WORK.run("zipList", [f])).map((e) => e.name);
      if (SB.findExportName(names)) return "health";
      if (names.some((n) => /(^|\/)activities\.csv$/i.test(n))) return "strava";
    } catch (e) { return "unknown"; }
    return "unknown";
  }
  const text = new TextDecoder().decode(head).replace(/^﻿/, "");
  const low = text.toLowerCase(), first = (low.split(/\r?\n/)[0] || "").trim();
  if (low.includes("<healthdata")) return "health";
  if (/<gpx[\s>]/.test(low) || low.includes("<trainingcenterdatabase")) return "activity";
  if (low.includes('"pulse-backup"')) return "backup";
  if (low.trim().startsWith("shc:/") || low.includes('"verifiablecredential"') || low.includes('"resourcetype"') || /^[\w-]+\.[\w-]+\.[\w-]+$/.test(text.trim())) return "fhir";
  if (first.includes("cycle start time") || first.includes("workout start time") || first.includes("question text") || (first.includes("sleep onset") && first.includes("nap"))) return "whoop";
  if (/^(name|date of birth|recorded date|classification|sample rate|lead|unit)\s*,/m.test(low) && low.includes("sample rate")) return "ecg";
  const cells = first.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
  if ((cells[0] === "lat" || cells[0] === "latitude") && cells.length >= 3) return "dem";
  if (SB.parseDay(cells[0]) !== null || cells.includes("date") || cells.includes("day")) return "daily";
  if (cells.length >= 3 && cells.slice(0, 3).every((c) => c !== "" && !isNaN(+c)) && Math.abs(+cells[0]) <= 90) return "dem";
  return "unknown";
}
const KIND_NAME = { activity: "activity files", health: "Apple Health export", strava: "Strava export", whoop: "Whoop files", daily: "daily CSV",
  dem: "elevation points", backup: "Pulse backup", fhir: "health records", ecg: "ECG recordings", unknown: "not recognised" };
async function importAny(files) {
  const groups = {};
  for (const f of Array.from(files)) { const k = await sniffFile(f); (groups[k] = groups[k] || []).push(f); }
  logLine("Recognised: " + Object.keys(groups).map((k) => groups[k].length + " " + KIND_NAME[k]).join(", ") + ".", groups.unknown ? "warn" : "good");
  for (const f of groups.unknown || []) logLine(f.name + ": Pulse does not recognise this file. Supported: GPX, TCX, FIT, Apple Health, Strava and Whoop exports, daily or elevation CSV, ECG CSV, FHIR records and Pulse backups.", "bad");
  if (groups.backup) for (const f of groups.backup) await importBackup(f);
  if (groups.activity) await importActivityFiles(groups.activity);
  if (groups.health) for (const f of groups.health) await importHealth(f);
  if (groups.strava) for (const f of groups.strava) await importStrava(f);
  if (groups.whoop) await importWhoop(groups.whoop);
  if (groups.daily) for (const f of groups.daily) await importDailyCsv(f);
  if (groups.dem) for (const f of groups.dem) await importDem(f);
  if (groups.fhir) { const n = await importFhirFiles(groups.fhir); logLine("Health records: " + n + " of " + groups.fhir.length + " file" + (groups.fhir.length === 1 ? "" : "s") + " read. See Body, Records.", n ? "good" : "warn"); }
  if (groups.ecg) { const n = await importEcgFiles(groups.ecg); logLine("ECG: " + n + " of " + groups.ecg.length + " recording" + (groups.ecg.length === 1 ? "" : "s") + " read. See Body, Records.", n ? "good" : "warn"); }
  invalidate(); route();
}
