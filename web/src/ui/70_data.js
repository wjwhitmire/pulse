// ---------------------------------------------------------------- import and export
let CANCELLED = false;
function logLine(text, kind) {
  const li = el("li", { cls: kind || "" }, [el("span", { cls: "grow", text })]);
  const ul = $("import-log");
  ul.prepend(li);
  while (ul.children.length > 200) ul.lastChild.remove();
}
function progress(on, frac, text) {
  $("progress").hidden = !on;
  if (frac !== undefined && frac !== null) $("progress-bar").value = frac;
  if (text !== undefined) $("progress-text").textContent = text;
}
async function leaveExample() {
  if (!APP.example) return;
  APP.example = false;
  APP.meta.clear(); APP.streams.clear(); APP.daily.clear();
  await loadAll();
  await autoUnits();
  invalidate();
}
// The first entry a person makes while the example is on screen starts their own log, so the
// entry is kept instead of being dropped with the example.
async function ownLog() {
  if (!APP.example) return false;
  await leaveExample();
  logLine("Started your own log. The example athlete is put away; delete everything in Settings to see it again.", "good");
  return true;
}
async function saveActivity(act, an, extra) {
  if (APP.meta.size >= MAX_ACTIVITIES) throw SB.err("limit", "Pulse keeps up to 5,000 activities on this device.");
  if (!act.start && act.t.length) act.start = act.t[0];
  const dup = isDuplicate(act.start);
  if (dup) return { duplicate: dup };
  if (!an) an = await WORK.run("analyze", [act, APP.settings, extra && extra.rpe ? extra.rpe : null]);
  const m = makeMeta(act, an, extra);
  m.row = rowOf(m);
  APP.meta.set(m.id, m);
  APP.streams.set(m.id, act);
  if (!APP.example) { await DB.put("streams", { id: m.id, act }); await DB.put("meta", m); }
  matchNewToSegments(m, act);
  return { id: m.id };
}
function matchNewToSegments(m, act) {
  let changed = false;
  for (const sg of APP.kv.segments) for (const e of SB.matchSegment(sg.seg, act)) { sg.efforts.push({ id: m.id, start: e.start, elapsed: e.elapsed }); changed = true; }
  if (changed) saveKv("segments");
}
async function saveSummaryActivity(summ, start, name, sport, extra) {
  const dup = isDuplicate(start);
  if (dup) return { duplicate: dup };
  const an = SB.analyzeSummary(Object.assign({ sport }, summ), APP.settings, extra && extra.rpe);
  const day = localDay(start), id = "a" + Math.round(start) + "-" + (extra && extra.source || "summary");
  const m = Object.assign({ id, source: extra && extra.source || "summary", name: name || defaultName(sport, start), sport, start, day, rpe: null, gear: null, file: null,
    summary_only: true, thumb: [], sig: null, an: Object.assign(an, { summary: summ }) }, extra || {});
  m.row = rowOf(m);
  APP.meta.set(id, m);
  if (!APP.example) await DB.put("meta", m);
  return { id };
}
async function storeOriginal(name, bytes) {
  if (APP.example || bytes.length > 50 * 1024 * 1024) return null;
  const id = "f" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
  await DB.put("files", { id, name: String(name).slice(0, 200), blob: new Blob([bytes]) });
  return id;
}
function xmlRoot(text) {
  const doc = new DOMParser().parseFromString(SB.checkXml(text), "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw SB.err("xml", "The file is not well-formed XML.");
  return doc.documentElement;
}
async function activitiesFromBytes(name, bytes) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".fit") || (bytes.length > 12 && bytes[8] === 0x2E && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54)) {
    const r = await WORK.run("decodeFit", [bytes, APP.settings]);
    if (!r.act.t.length && r.act.rr.length) return [{ hrvOnly: r.act }];
    return [{ act: r.act, an: r.an }];
  }
  const text = SB.xmlText(bytes), root = xmlRoot(text);
  const acts = root.localName === "gpx" ? SB.parseGpxDoc(root) : SB.parseTcxDoc(root);
  return acts.map((act) => ({ act, an: null }));
}
async function importActivityFiles(files) {
  await leaveExample();
  CANCELLED = false;
  const list = Array.from(files).filter((f) => /\.(gpx|tcx|fit)$/i.test(f.name));
  if (!list.length) { logLine("No .gpx, .tcx or .fit files in the selection.", "warn"); return; }
  progress(true, 0, "Reading " + list.length + " files");
  let ok = 0, dup = 0, bad = 0;
  for (let i = 0; i < list.length && !CANCELLED; i++) {
    const f = list[i];
    progress(true, i / list.length, (i + 1) + " of " + list.length + ": " + f.name);
    try {
      if (f.size > SB.MAX_ACTIVITY_BYTES) throw SB.err("size", "over the 50 MB limit");
      const bytes = new Uint8Array(await f.arrayBuffer());
      const items = await activitiesFromBytes(f.name, bytes);
      let fileId = null;
      for (const it of items) {
        if (it.hrvOnly) { await addHrvReading(it.hrvOnly); ok++; continue; }
        if (fileId === null) fileId = await storeOriginal(f.name, bytes);
        if (it.act.warnings && it.act.warnings.length) logLine(f.name + ": read with warnings: " + it.act.warnings.slice(0, 3).join("; ") + ".", "warn");
        const r = await saveActivity(it.act, it.an, { file: fileId });
        if (r.duplicate) dup++; else ok++;
      }
    } catch (e) {
      if (e.code === "cancel") break;
      bad++; logLine(f.name + ": " + e.message, "bad");
    }
  }
  progress(false);
  logLine(`Activities: ${ok} added, ${dup} already here (same start time), ${bad} could not be read.` + (CANCELLED ? " Cancelled." : ""), bad ? "warn" : "good");
  await afterImport();
}
async function addHrvReading(act) {
  // A short FIT recording with beat-to-beat intervals: a morning HRV reading for that day.
  const r = SB.rmssd(act.rr);
  if (r === null) throw SB.err("hrv", "The beat-to-beat data was too short or too noisy for an HRV value.");
  const z = localDay(act.start || Date.now() / 1000);
  await mergeDaily([Object.assign(SB.blankDay(z), { rmssd: r })]);
  logLine("Morning HRV reading for " + fmtDay(z) + ": rMSSD " + r.toFixed(0) + " ms.", "good");
}
async function mergeDaily(rowsIn) {
  const changed = [];
  for (const r of rowsIn) {
    if (r.date === null || r.date === undefined) continue;
    const cur = APP.daily.get(r.date) || SB.blankDay(r.date);
    for (const k of SB.DAY_KEYS) if (r[k] !== null && r[k] !== undefined) cur[k] = r[k];
    APP.daily.set(r.date, cur); changed.push(cur);
  }
  if (!APP.example) await DB.putMany("daily", changed);
  return changed.length;
}
async function importHealth(file) {
  await leaveExample();
  CANCELLED = false;
  progress(true, 0, "Reading " + file.name);
  try {
    const res = await WORK.run("health", [file], (p) => progress(true, p, "Reading the Health export: " + Math.round(p * 100) + "%"));
    const n = await mergeDaily(res.days);
    if (res.extras.hr.length) {
      const map = new Map(APP.kv.hr.map((x) => [x[0], x]));
      for (const x of res.extras.hr) map.set(x[0], x);
      const all = Array.from(map.values()).sort((a, b) => a[0] - b[0]);
      const lo = all.length ? all[all.length - 1][0] - 120 * 1440 : 0;
      APP.kv.hr = all.filter((x) => x[0] > lo);
      await saveKv("hr");
    }
    if (res.extras.sdnn.length) { APP.kv.sdnn = res.extras.sdnn.slice(-5000); await saveKv("sdnn"); }
    if (res.extras.body.length) { APP.kv.body = APP.kv.body.concat(res.extras.body).slice(-20000); await saveKv("body"); }
    if (!res.records && !(res.routes && res.routes.length) && !(res.clinical && res.clinical.length) && !(res.ecgs && res.ecgs.length))
      throw SB.err("health", "No Apple Health records found. Pick export.zip or export.xml from Export All Health Data.");
    logLine(`Apple Health: ${res.records.toLocaleString("en-US")} records read, ${n} days updated.`, "good");
    if (res.routes && res.routes.length) {
      let added = 0;
      for (let i = 0; i < res.routes.length && !CANCELLED && i < 5000; i++) {
        progress(true, i / res.routes.length, "Workout routes: " + (i + 1) + " of " + res.routes.length);
        try {
          const bytes = await WORK.run("zipRead", [file, res.routes[i], false]);
          for (const it of await activitiesFromBytes(res.routes[i].name, bytes)) { const r = await saveActivity(it.act, it.an, { source: "apple" }); if (!r.duplicate) added++; }
        } catch (e) { if (e.code === "cancel") break; }
      }
      logLine(`Apple Health workout routes: ${added} added.`, "good");
    }
    const dec = new TextDecoder();
    if (res.clinical && res.clinical.length && typeof importFhirFiles === "function") {
      const texts = [];
      for (const ent of res.clinical) { try { texts.push([ent.name.split("/").pop(), dec.decode(await WORK.run("zipRead", [file, ent, false]))]); } catch (e) {} }
      await importFhirFiles([], texts);
      logLine(`Apple Health clinical records: ${texts.length} files read.`, "good");
    }
    if (res.ecgs && res.ecgs.length && typeof importEcgFiles === "function") {
      const texts = [];
      for (const ent of res.ecgs) { try { texts.push([ent.name.split("/").pop(), dec.decode(await WORK.run("zipRead", [file, ent, false]))]); } catch (e) {} }
      await importEcgFiles([], texts);
      logLine(`Apple Health ECGs: ${texts.length} recordings read.`, "good");
    }
  } catch (e) { logLine(file.name + ": " + e.message, "bad"); }
  progress(false); await afterImport();
}
async function importStrava(file) {
  await leaveExample();
  CANCELLED = false;
  progress(true, 0, "Opening the Strava export");
  try {
    if (file.size > 4 * 1024 * 1024 * 1024) throw SB.err("size", "The export is larger than 4 GB.");
    const entries = await WORK.run("zipList", [file]);
    const csvEnt = entries.find((e) => /(^|\/)activities\.csv$/i.test(e.name));
    if (!csvEnt) throw SB.err("zip", "No activities.csv in this zip. Is it the bulk export from Strava's account settings?");
    const ix = SB.stravaIndex(new TextDecoder().decode(await WORK.run("zipRead", [csvEnt && file, csvEnt, false])));
    const gearByName = new Map(APP.kv.gear.map((g) => [g.name, g]));
    const gearFor = (name, sport) => {
      if (!name) return null;
      if (!gearByName.has(name)) { const g = { id: "gear" + Date.now() + gearByName.size, name, kind: sport === "ride" ? "bike" : "shoe", start_km: 0, retire_km: null }; APP.kv.gear.push(g); gearByName.set(name, g); }
      return gearByName.get(name).id;
    };
    const files = entries.filter((e) => ix.files[e.name.toLowerCase()] || /^activities\/.+\.(fit|gpx|tcx)(\.gz)?$/i.test(e.name));
    let ok = 0, dup = 0, bad = 0;
    for (let i = 0; i < files.length && !CANCELLED; i++) {
      const ent = files[i], info = ix.files[ent.name.toLowerCase()] || {};
      progress(true, i / files.length, "Strava: " + (i + 1) + " of " + files.length);
      try {
        const gz = /\.gz$/i.test(ent.name);
        const bytes = await WORK.run("zipRead", [file, ent, gz]);
        const nm = ent.name.replace(/\.gz$/i, "");
        for (const it of await activitiesFromBytes(nm, bytes)) {
          if (!it.act) continue;
          if (info.sport && info.sport !== "other") it.act.sport = info.sport === "strength" ? "strength" : info.sport;
          const r = await saveActivity(it.act, it.an, { source: "strava", name: info.name || undefined, gear: gearFor(info.gear, it.act.sport) });
          if (r.duplicate) dup++; else ok++;
        }
      } catch (e) { if (e.code === "cancel") break; bad++; logLine(ent.name + ": " + e.message, "bad"); }
    }
    let man = 0;
    for (const e of ix.manual) {
      const t = parseLooseDate(e.date);
      if (t === null || !e.elapsed) continue;
      const r = await saveSummaryActivity({ duration: e.elapsed, distance: e.distance || 0 }, t, e.name, e.sport, { source: "strava", gear: gearFor(e.gear, e.sport) });
      if (!r.duplicate) man++;
    }
    await saveKv("gear");
    logLine(`Strava: ${ok} activities with files, ${man} without, ${dup} already here, ${bad} unreadable.` + (CANCELLED ? " Cancelled." : ""), bad ? "warn" : "good");
  } catch (e) { logLine(file.name + ": " + e.message, "bad"); }
  progress(false); await afterImport();
}
function parseLooseDate(s) {
  // Strava writes "Jan 2, 2026, 7:00:00 AM" (UTC). Parse the parts ourselves.
  const m = /([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?/i.exec(s || "");
  if (!m) { const t = SB.parseTime(s); return t; }
  const mo = MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase()) + 1;
  if (mo < 1) return null;
  let h = parseInt(m[4], 10) % 12;
  if (m[7] && m[7].toUpperCase() === "PM") h += 12;
  if (!m[7]) h = parseInt(m[4], 10);
  return SB.daysFromCivil(+m[3], mo, +m[2]) * 86400 + h * 3600 + (+m[5]) * 60 + (+m[6]);
}
async function importWhoop(files) {
  await leaveExample();
  let days = 0, acts = 0, answers = 0;
  for (const f of Array.from(files)) {
    try {
      if (f.size > 50 * 1024 * 1024) throw SB.err("size", "over the 50 MB limit");
      const text = await f.text(), head = text.slice(0, 2000).toLowerCase();
      if (head.includes("question text")) {
        const j = SB.whoopJournal(text);
        for (const z of Object.keys(j)) { APP.kv.journal[z] = Object.assign(APP.kv.journal[z] || {}, j[z]); answers += Object.keys(j[z]).length; }
        await saveKv("journal");
      } else if (head.includes("workout start time")) {
        for (const w of SB.whoopWorkouts(text)) {
          const t = SB.parseTime(w.start_text);
          if (t === null) continue;
          const r = await saveSummaryActivity({ duration: w.duration, distance: w.distance || 0, avg_hr: w.avg_hr, max_hr: w.max_hr, kcal: w.kcal, gain: w.gain }, t, w.name, w.sport, { source: "whoop" });
          if (!r.duplicate) acts++;
        }
      } else if (head.includes("cycle start time") && head.includes("resting heart rate")) {
        days += await mergeDaily(SB.whoopCycles(text));
      } else if (head.includes("nap")) {
        const naps = SB.whoopNaps(text);
        await mergeDaily(Object.keys(naps).map((z) => Object.assign(SB.blankDay(+z), { nap: naps[z] })));
      } else throw SB.err("csv", "not a Whoop export file Pulse knows");
    } catch (e) { logLine(f.name + ": " + e.message, "bad"); }
  }
  logLine(`Whoop: ${days} days of measurements, ${acts} workouts (summaries), ${answers} journal answers. Whoop's own scores are not imported; Pulse computes its own from the measurements.`, "good");
  await afterImport();
}
async function importDailyCsv(file) {
  await leaveExample();
  try {
    if (file.size > 5 * 1024 * 1024) throw SB.err("size", "over the 5 MB limit");
    const n = await mergeDaily(SB.parseDailyCsv(await file.text()));
    logLine(`Daily CSV: ${n} days.`, "good");
  } catch (e) { logLine(file.name + ": " + e.message, "bad"); }
  await afterImport();
}
async function importDem(file) {
  try {
    if (file.size > 20 * 1024 * 1024) throw SB.err("size", "over the 20 MB limit");
    const pts = SB.parseDem(await file.text());
    await ownLog();
    APP.dem = pts;
    APP.kv.dem = APP.dem; await saveKv("dem");
    logLine(`Elevation points: ${APP.dem.length.toLocaleString("en-US")} loaded. Activity pages now show climbs corrected with them beside the recorded values.`, "good");
  } catch (e) { logLine(file.name + ": " + e.message, "bad"); }
}

// ---------------------------------------------------------------- backup and export
async function allStreams() {
  const out = {};
  for (const id of APP.meta.keys()) { const s = await getStreams(id); if (s) out[id] = s; }
  return out;
}
async function backupObject() {
  return { format: "pulse-backup", version: 1, exported: new Date().toISOString(), example: APP.example, settings: APP.settings, kv: APP.kv,
    daily: dailyList(), activities: metaList(), streams: await allStreams() };
}
function activitiesCsv() {
  const head = ["date", "start_utc", "name", "sport", "distance_m", "moving_s", "elapsed_s", "climb_m", "load", "kcal", "avg_hr", "source"];
  const lines = [head.join(",")];
  for (const m of metaList()) {
    const r = m.row, an = m.an || {};
    lines.push([SB.dayStr(m.day), new Date(m.start * 1000).toISOString(), m.name, m.sport, r.distance.toFixed(1), r.moving.toFixed(0), r.elapsed.toFixed(0), (r.gain || 0).toFixed(1),
      r.load === null ? "" : r.load.toFixed(1), r.kcal === null ? "" : r.kcal.toFixed(0), an.hr ? an.hr.avg.toFixed(0) : (an.avg_hr || ""), m.source].map(SB.csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
function dailyCsv() {
  const keys = ["rmssd", "sdnn", "rhr", "sleep", "nap", "in_bed", "steps", "active_kcal", "resp", "spo2", "wrist_temp"];
  const lines = [["date"].concat(keys.map((k) => ({ rmssd: "rmssd_ms", sdnn: "sdnn_ms", rhr: "resting_hr", sleep: "sleep_hours", nap: "nap_hours", in_bed: "in_bed_hours" }[k] || k))).join(",")];
  for (const d of dailyList()) lines.push([SB.dayStr(d.date)].concat(keys.map((k) => (d[k] === null || d[k] === undefined ? "" : +(+d[k]).toFixed(3)))).map(SB.csvCell).join(","));
  return lines.join("\n") + "\n";
}
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
// Entry names: ASCII word characters, dots and dashes only, no empty, "." or ".." parts, so an
// unzip tool cannot be steered outside its folder by a name that came from an imported file.
function safeZipName(name) {
  const parts = String(name).split("/").map((p) => p.replace(/[^\w.-]/g, "_")).filter((p) => p && p !== "." && p !== "..");
  return parts.map((p) => (/^\.+$/.test(p) ? "_" : p)).join("/") || "file";
}
function zipStore(files) {
  // Store-only zip (no compression) written by hand; names are ASCII-safe.
  const parts = [], cd = [];
  let off = 0;
  const enc = new TextEncoder();
  const u16 = (v) => [v & 255, (v >>> 8) & 255], u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  for (const [name, data] of files) {
    const nm = enc.encode(safeZipName(name)), crc = crc32(data);
    const lh = new Uint8Array([].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(nm.length), u16(0)));
    parts.push(lh, nm, data);
    cd.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(nm.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off))), nm);
    off += lh.length + nm.length + data.length;
  }
  const cdSize = cd.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(off), u16(0)));
  return new Blob(parts.concat(cd, [end]), { type: "application/zip" });
}
async function exportZip() {
  setStatus("Building the export.");
  const enc = new TextEncoder(), files = [["pulse-backup.json", enc.encode(JSON.stringify(await backupObject()))], ["activities.csv", enc.encode(activitiesCsv())], ["daily.csv", enc.encode(dailyCsv())]];
  const fl = (await DB.all("files")) || [];
  for (const f of fl) {
    if (!f.blob) continue;
    const owner = Array.from(APP.meta.values()).find((m) => m.file === f.id);
    files.push(["originals/" + (owner ? SB.dayStr(owner.day) + "_" : "") + f.name, new Uint8Array(await f.blob.arrayBuffer())]);
  }
  for (const m of metaList()) if (!m.summary_only && m.thumb && m.thumb.length) {
    const act = await getStreams(m.id);
    if (act) files.push(["gpx/" + SB.dayStr(m.day) + "_" + m.id + ".gpx", enc.encode(SB.toGpx(act, m.name))]);
  }
  await saveBlob(zipStore(files), "pulse-export-" + SB.dayStr(todayDay()) + ".zip", $("ex-out"));
}
async function importBackup(file) {
  try {
    if (file.size > 500 * 1024 * 1024) throw SB.err("size", "over the 500 MB limit");
    const o = JSON.parse(await file.text());
    if (!o || o.format !== "pulse-backup" || !Array.isArray(o.activities) || !Array.isArray(o.daily)) throw SB.err("backup", "not a Pulse backup file");
    await leaveExample();
    APP.settings = SB.settingsWith(o.settings && typeof o.settings === "object" ? o.settings : {});
    await saveKv("settings");
    // Network switches are never restored from a file: each one is turned on by a person in Settings.
    // Each other section is taken only when it has the shape Pulse writes (a list stays a list).
    const shape = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
    const want = defaultKv();
    let skipped = 0;
    for (const k of KV_KEYS) {
      if (k === "settings" || k === "net" || !o.kv || typeof o.kv !== "object" || !Object.prototype.hasOwnProperty.call(o.kv, k)) continue;
      const v = o.kv[k];
      if (shape(v) !== shape(want[k]) && !(want[k] === null && (shape(v) === "array" || shape(v) === "null"))) { skipped++; continue; }
      APP.kv[k] = v; await saveKv(k);
    }
    APP.dem = APP.kv.dem || null;
    let added = 0;
    for (const m of o.activities) {
      if (!m || typeof m !== "object" || typeof m.id !== "string" || typeof m.start !== "number" || !Number.isFinite(m.start)) { skipped++; continue; }
      if (APP.meta.has(m.id)) continue;
      if (APP.meta.size >= MAX_ACTIVITIES) { skipped++; continue; }
      try { m.row = rowOf(m); } catch (e) { skipped++; continue; }
      if (typeof m.day !== "number") m.day = localDay(m.start);
      APP.meta.set(m.id, m); await DB.put("meta", m); added++;
      const st = o.streams && typeof o.streams === "object" ? o.streams[m.id] : null;
      if (st && typeof st === "object" && Array.isArray(st.t)) await DB.put("streams", { id: m.id, act: st });
    }
    const days = o.daily.filter((d) => d && typeof d.date === "number" && Number.isFinite(d.date)).map((d) => {
      const r = SB.blankDay(d.date);
      for (const k of SB.DAY_KEYS) if (typeof d[k] === "number" && Number.isFinite(d[k])) r[k] = d[k]; else if (k === "stages" && d[k] && typeof d[k] === "object") r[k] = d[k];
      return r;
    });
    skipped += o.daily.length - days.length;
    await mergeDaily(days);
    logLine(`Backup restored: ${added} activities, ${days.length} days.` + (skipped ? ` ${skipped} damaged entries skipped.` : "") + " Network switches were left as they are.", skipped ? "warn" : "good");
  } catch (e) { logLine(file.name + ": " + (e instanceof SyntaxError ? "not valid JSON" : e.message), "bad"); }
  invalidate(); route();
}
async function deleteAll() {
  const ok = await DB.clear();
  if (typeof COACH !== "undefined") COACH.history = [];
  APP.kv = defaultKv(); APP.dem = null;
  APP.settings = SB.settingsWith(null);
  APP.meta.clear(); APP.streams.clear(); APP.daily.clear();
  try { localStorage.removeItem("pulse.theme"); } catch (e) {}
  $("del-confirm").hidden = true;
  APP.settingsSaved = false;
  await autoUnits(false); // units for the example on screen; nothing is written until the person adds data
  await startExample();
  setStatus(ok ? "Everything Pulse stored on this device is deleted. The example data is back on screen."
    : "The browser refused part of the delete. Clear this site's data in the browser's settings to be sure nothing is left.");
}

// ---------------------------------------------------------------- settings form
const SETTINGS_FIELDS = [
  ["max_hr", "Maximum heart rate", "bpm", 120, 230, 1], ["rest_hr", "Resting heart rate", "bpm", 30, 100, 1],
  ["trimp_sex", "Load weighting", "Banister 1991: male 0.64 e^(1.92x), female 0.86 e^(1.67x)", ["male", "female"]],
  ["zone_method", "Heart rate zones", "Reserve (Karvonen) or percent of maximum", ["hrr", "max"]],
  ["load_method", "Activity load", "Banister (exponential), zone (Edwards) or threshold (Lucia, needs both thresholds)", ["banister", "edwards", "lucia"]],
  ["vt1_hr", "First threshold heart rate", "bpm, for threshold load; 0 = unknown", 0, 220, 1], ["vt2_hr", "Second threshold heart rate", "bpm; 0 = unknown", 0, 230, 1],
  ["ftp", "Functional threshold power", "W; 0 = unknown", 0, 600, 1], ["threshold_pace", "Threshold pace", "min:ss per km; blank = unknown", "pace"],
  ["weight_kg", "Body weight", "kg, for energy", 30, 250, 0.1], ["age", "Age", "years, for energy and fitness age", 10, 100, 1],
  ["units", "Units", "Distances and paces", ["km", "mi"]],
  ["fit_tau", "Long-term load time constant", "days (42 is common)", 7, 120, 1], ["fat_tau", "Short-term load time constant", "days (7 is common)", 2, 30, 1],
  ["run_stop", "Running: stopped below", "m/s", 0.1, 3, 0.1], ["run_go", "Running: moving again at", "m/s", 0.2, 4, 0.1],
  ["ride_stop", "Riding: stopped below", "m/s", 0.2, 5, 0.1], ["ride_go", "Riding: moving again at", "m/s", 0.3, 6, 0.1],
  ["min_stop", "Shortest stop that counts", "s", 0, 120, 1], ["ele_window", "Elevation smoothing", "samples", 1, 61, 2], ["ele_hyst", "Ignore climbs and dips under", "m", 0, 20, 0.5],
  ["sleep_base", "Baseline sleep need", "hours", 4, 12, 0.25], ["sleep_debt_share", "Share of last week's sleep debt added", "0 to 1", 0, 1, 0.05],
  ["sleep_load_per100", "Extra sleep per 100 load (heuristic)", "hours; 0 = off", 0, 2, 0.05], ["wake", "Wake time", "for the bedtime plan", "time"], ["sleep_latency", "Time to fall asleep", "minutes", 0, 90, 5],
];
function renderSettingsForm() {
  const form = clear($("settings-form")), s = APP.settings;
  for (const f of SETTINGS_FIELDS) {
    const [key, label, hint, a] = f, id = "set-" + key;
    let input;
    if (Array.isArray(a)) {
      input = el("select", { id });
      for (const o of a) input.append(el("option", { value: o, text: { hrr: "Heart rate reserve", max: "Percent of maximum", banister: "Banister", edwards: "Zone (Edwards)", lucia: "Threshold (Lucia)", male: "Male coefficients", female: "Female coefficients", km: "Kilometres", mi: "Miles" }[o] || o }));
      input.value = s[key];
    } else if (a === "pace") {
      input = el("input", { id, type: "text", inputmode: "numeric", placeholder: "4:30", value: s.threshold_speed ? fmtDur(1000 / s.threshold_speed) : "" });
    } else if (a === "time") {
      input = el("input", { id, type: "time", value: SB.fmtClock(s.wake_min) });
    } else input = el("input", { id, type: "number", min: String(a), max: String(f[4]), step: String(f[5]), value: String(s[key]) });
    form.append(el("div", null, [el("label", { for: id, text: label }), input, el("span", { cls: "h", text: hint })]));
  }
}
async function saveSettings() {
  const s = Object.assign({}, APP.settings), refused = [];
  for (const f of SETTINGS_FIELDS) {
    const [key, , , a] = f, v = $("set-" + key).value;
    if (Array.isArray(a)) s[key] = a.includes(v) ? v : s[key];
    else if (a === "pace") {
      const m = /^(\d{1,2}):([0-5]\d)$/.exec(v.trim());
      if (m && +m[1] * 60 + +m[2] > 0) s.threshold_speed = 1000 / (+m[1] * 60 + +m[2]);
      else if (!v.trim()) s.threshold_speed = 0;
      else refused.push("threshold pace (use min:ss, for example 4:30)");
    }
    else if (a === "time") { const m = /^(\d{1,2}):(\d{2})/.exec(v); if (m) s.wake_min = +m[1] * 60 + +m[2]; }
    else { const x = parseFloat(v); if (Number.isFinite(x) && x >= a && x <= f[4]) s[key] = x; else if (String(+s[key]) !== v) refused.push(f[1].toLowerCase() + " (" + a + " to " + f[4] + ")"); }
  }
  if (refused.length) { setStatus("Not saved. Check: " + refused.join("; ") + "."); return; }
  if (s.rest_hr >= s.max_hr) { setStatus("Resting heart rate must be below maximum heart rate."); return; }
  // Values typed here are the person's own: automatic estimates never overwrite them afterwards.
  const changed = AUTO_KEYS.filter((k) => s[k] !== APP.settings[k]);
  await ownLog();
  for (const k of changed) { APP.kv.custom[k] = true; delete APP.kv.auto[k]; }
  APP.settings = SB.settingsWith(s);
  await saveKv("settings"); await saveKv("custom"); await saveKv("auto");
  await recomputeAll();
}
async function afterImport() {
  invalidate();
  if (!(await applyAuto())) route();
}
async function recomputeAll(msg) {
  CANCELLED = false;
  const ms = Array.from(APP.meta.values());
  progress(true, 0, "Recomputing with the new settings");
  for (let i = 0; i < ms.length && !CANCELLED; i++) {
    const m = ms[i];
    if (i % 5 === 0) progress(true, i / ms.length, "Recomputing " + (i + 1) + " of " + ms.length);
    try {
      if (m.summary_only) { const sm = m.an && m.an.summary; if (sm) m.an = Object.assign(SB.analyzeSummary(Object.assign({ sport: m.sport }, sm), APP.settings, m.rpe), { summary: sm }); }
      else { const act = await getStreams(m.id); if (!act) continue; m.an = stripAn(await WORK.run("analyze", [act, APP.settings, m.rpe])); }
      m.row = rowOf(m);
      if (!APP.example) await DB.put("meta", m);
    } catch (e) { if (e.code === "cancel") break; }
  }
  progress(false); invalidate(); setStatus(msg || "Settings saved."); route();
}
