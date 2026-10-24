// ---------------------------------------------------------------- health records: FHIR, labs, ECG, BP cuff, clinician report
function renderHealth() {
  const root = clear($("health-root"));
  if (typeof PulseFHIR === "undefined") { root.append(el("p", { cls: "muted", text: "Health record modules are not part of this build." })); return; }
  const med = APP.kv.medical || [];
  // import card
  const imp = el("article", { cls: "card" }, [el("div", { cls: "card-h" }, [icon("import"), el("h3", { text: "Medical records, labs and ECGs" })]),
    el("p", { cls: "muted", text: "Import FHIR R4 JSON (Apple Health clinical records, Blue Button 2.0, patient portals), SMART Health Cards, lab CSVs and ECG CSVs. Read on this device; nothing is uploaded. The Apple Health zip import also reads its clinical records and ECGs." })]);
  const fin = el("input", { type: "file", id: "in-fhir", multiple: "true", accept: ".json,.smart-health-card,.txt" });
  const ein = el("input", { type: "file", id: "in-ecg", multiple: "true", accept: ".csv,.txt" });
  imp.append(el("div", { cls: "imports" }, [
    el("div", null, [el("label", { for: "in-fhir", text: "FHIR JSON or SMART Health Card" }), fin]),
    el("div", null, [el("label", { for: "in-ecg", text: "ECG CSV (Apple Health electrocardiograms or single-lead CSV)" }), ein])]));
  fin.addEventListener("change", async () => { await importFhirFiles(Array.from(fin.files)); fin.value = ""; renderHealth(); });
  ein.addEventListener("change", async () => { await importEcgFiles(Array.from(ein.files)); ein.value = ""; renderHealth(); });
  root.append(imp);
  root.append(el("p", { cls: "notice" }, [icon("info"), el("span", { text: "Records and labs are shown as imported, each lab against its own reference range. Pulse describes and does not interpret; this is not medical advice." })]));
  // records timeline
  const res = mergedFhir();
  const tl = PulseFHIR.timeline(res).filter((e) => e.type !== "observation").slice(-80).reverse();
  const tcard = el("article", { cls: "card" }, [el("div", { cls: "card-h" }, [icon("log"), el("h3", { text: "Records" })])]);
  const tt = el("table", { cls: "splits" });
  table(tt, ["Date", "Type", "Record"], tl.map((e) => [e.date ? String(e.date).slice(0, 10) : "-", e.type, e.label]), { empty: "No records imported.", cls: ["", "txt", "txt"] });
  tcard.append(el("div", { cls: "tbl-wrap" }, [tt]));
  root.append(tcard);
  // labs
  const series = PulseFHIR.labSeries(res.observations);
  const lcard = el("article", { cls: "card" }, [el("div", { cls: "card-h" }, [icon("trends"), el("h3", { text: "Lab results" })]),
    el("p", { cls: "muted small", text: "Each marker against the reference range its lab supplied. Pulse does not interpret results beyond inside or outside that range." })]);
  const lt = el("table", { cls: "splits" });
  table(lt, ["Marker", "Latest", "Range", "Position", "Date"], series.map((g) => {
    const p = g.points[g.points.length - 1];
    return [g.name || g.loinc || "-", p.value + " " + (p.unit || ""), (p.low !== null ? p.low : "") + " to " + (p.high !== null ? p.high : ""), p.position || "no range", String(p.date).slice(0, 10)];
  }), { empty: "No lab results imported.", cls: ["txt", "r", "r", "txt", ""] });
  lcard.append(el("div", { cls: "tbl-wrap" }, [lt]));
  root.append(lcard);
  // ECG
  const ecard = el("article", { cls: "card" }, [el("div", { cls: "card-h" }, [icon("hrv"), el("h3", { text: "ECG recordings" })])]);
  const ecgs = APP.kv.ecg || [];
  if (!ecgs.length) ecard.append(el("p", { cls: "muted", text: "No ECGs imported." }));
  ecgs.slice(-10).reverse().forEach((rec, i) => {
    const a = PulseECG.analyze(rec);
    const cv = el("canvas", { width: "1500", height: "300", cls: "ecg", "aria-label": "ECG on 25 mm/s, 10 mm/mV paper" });
    ecard.append(el("p", { cls: "label", text: (rec.meta && rec.meta.recordedDate ? rec.meta.recordedDate : "Recording " + (i + 1)) }),
      el("div", { cls: "map ecg-wrap" }, [cv]),
      el("p", { cls: "muted small", text: "Heart rate from detected beats: " + (a.heartRate && a.heartRate.meanHr ? Math.round(a.heartRate.meanHr) + " bpm (" + a.heartRate.beats + " beats)" : "-") + ". Device classification, as the device reported it: " + (a.deviceClassification || "none") + ". Pulse does not diagnose." }));
    drawEcg(cv, rec);
  });
  ecard.append(el("p", { cls: "notice" }, [icon("info"), el("span", { text: "An ECG on this page is a picture of a recording, not a diagnosis. For symptoms, see a doctor." })]));
  root.append(ecard);
  // BP cuff
  const bcard = el("article", { cls: "card" }, [el("div", { cls: "card-h" }, [icon("bt"), el("h3", { text: "Blood pressure cuff" })]),
    el("p", { cls: "muted", text: "Cuffs that support the Bluetooth Blood Pressure service send their reading here directly; it is saved in the body log. Chrome and Edge only." }),
    el("div", { cls: "btn-row" }, [el("button", { type: "button", cls: "btn", text: "Connect a cuff", onclick: connectCuff })])]);
  root.append(bcard);
  // clinician report
  const rcard = el("article", { cls: "card" }, [el("div", { cls: "card-h" }, [icon("share"), el("h3", { text: "Report for your clinician" })]),
    el("p", { cls: "muted", text: "A summary of resting heart rate, HRV, sleep, weight and blood pressure for the last 90 days, plus labs and medications you imported, as text and as a FHIR R4 bundle. You decide where it goes." })]);
  const out = el("textarea", { cls: "outbox", readonly: "true", "aria-label": "Report text", id: "report-out" });
  rcard.append(el("div", { cls: "btn-row" }, [
    el("button", { type: "button", cls: "btn primary", text: "Build report", onclick: () => { const r = buildClinicianReport(); out.value = r ? PulseReport.summaryText(r) : "Not enough data for a report."; } }),
    el("button", { type: "button", cls: "btn", text: "Save as FHIR bundle", onclick: () => { const r = buildClinicianReport(); if (r) saveBlob(new Blob([JSON.stringify(PulseReport.toFhirBundle(r), null, 1)], { type: "application/fhir+json" }), "pulse-report-fhir.json", out); } }),
    el("button", { type: "button", cls: "btn", id: "report-print", text: "Print or save as PDF", onclick: () => printReport(out) }),
    el("button", { type: "button", cls: "btn ghost", text: "Copy text", onclick: () => copyText(out.value || "", out) })]), out);
  root.append(rcard);
}
// The report alone on paper: the browser's print dialog saves it as a PDF too.
function printReport(out) {
  const r = buildClinicianReport();
  if (!r) { setStatus("Not enough data for a report yet: import resting heart rate, HRV, sleep, weight or blood pressure."); return; }
  const text = PulseReport.summaryText(r);
  if (out) out.value = text;
  let p = $("print-report");
  if (!p) { p = el("pre", { id: "print-report" }); document.body.append(p); }
  p.textContent = text;
  document.body.classList.add("printing");
  const done = () => { document.body.classList.remove("printing"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  try { window.print(); } catch (e) { done(); setStatus("Printing is blocked here. Use Copy text instead."); }
}
function mergedFhir() {
  const res = { patient: null, conditions: [], medications: [], immunizations: [], allergies: [], observations: [], skipped: {}, warnings: [], counts: {} };
  for (const r of APP.kv.medical || []) for (const k of ["conditions", "medications", "immunizations", "allergies", "observations"]) res[k] = res[k].concat(r[k] || []);
  return res;
}
async function inflateCard(text) {
  // SMART Health Cards are raw-DEFLATE compressed; inflate with the browser, then read the bundle.
  let jws = text.trim();
  if (jws.startsWith("shc:/")) jws = PulseFHIR.shcNumericToJws(jws);
  else if (jws.startsWith("{")) { const o = JSON.parse(jws); jws = (o.verifiableCredential || [])[0] || ""; }
  const parts = jws.split(".");
  if (parts.length !== 3) throw SB.err("card", "Not a SMART Health Card.");
  // base64urlDecode gives a plain array of byte values; a Blob made from it would hold their text.
  const bytes = new Uint8Array(PulseFHIR.base64urlDecode(parts[1]));
  let inflated;
  try { inflated = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()); }
  catch (e) { throw SB.err("card", "The card's contents could not be decompressed; the file is damaged or not a SMART Health Card."); }
  const payload = JSON.parse(PulseFHIR.utf8Decode(inflated));
  const bundle = payload && payload.vc && payload.vc.credentialSubject ? payload.vc.credentialSubject.fhirBundle : null;
  if (!bundle) throw SB.err("card", "The card has no FHIR bundle.");
  return PulseFHIR.parse(JSON.stringify(bundle));
}
async function importFhirFiles(files, texts) {
  await ownLog();
  let n = 0;
  const items = texts || [];
  for (const f of files) { if (f.size > 32 * 1024 * 1024) { logLine(f.name + ": over the 32 MB limit", "bad"); continue; } items.push([f.name, await f.text()]); }
  for (const [name, text] of items) {
    try {
      const t = text.trim();
      const r = t.startsWith("shc:/") || /^[\w-]+\.[\w-]+\.[\w-]+$/.test(t) || name.endsWith(".smart-health-card") ? await inflateCard(t) : PulseFHIR.parse(t);
      const rec = { conditions: r.conditions, medications: r.medications, immunizations: r.immunizations, allergies: r.allergies, observations: r.observations };
      // The same records imported again (a card as a file and as QR text, or a second download) are kept once.
      const key = JSON.stringify(rec);
      if (APP.kv.medical.some((m) => JSON.stringify({ conditions: m.conditions, medications: m.medications, immunizations: m.immunizations, allergies: m.allergies, observations: m.observations }) === key)) { logLine(name + ": already imported.", "warn"); continue; }
      APP.kv.medical.push(Object.assign(rec, { source: String(name).slice(0, 120) }));
      n++;
    } catch (e) { logLine(name + ": " + e.message, "bad"); setStatus(name + ": " + e.message); }
  }
  if (n) { await saveKv("medical"); setStatus(n + " record file" + (n === 1 ? "" : "s") + " read."); }
  return n;
}
async function importEcgFiles(files, texts) {
  await ownLog();
  const items = texts || [];
  for (const f of files) { if (f.size > 20 * 1024 * 1024) continue; items.push([f.name, await f.text()]); }
  let n = 0;
  for (const [name, text] of items) {
    try {
      const rec = PulseECG.parse(text, {});
      const n0 = rec.samples.length, probe = [0, n0 >> 2, n0 >> 1, (3 * n0) >> 2, n0 - 1];
      const same = (e) => e.samples.length === n0 && e.sampleRate === rec.sampleRate && (e.meta && e.meta.recordedDate) === (rec.meta && rec.meta.recordedDate) && probe.every((i) => e.samples[i] === Math.round(rec.samples[i]));
      if (APP.kv.ecg.some(same)) { logLine(name + ": already imported.", "warn"); continue; }
      APP.kv.ecg.push({ meta: rec.meta, sampleRate: rec.sampleRate, samples: rec.samples.map((x) => Math.round(x)), lead: rec.lead || null });
      n++;
    } catch (e) { setStatus(name + ": " + e.message); logLine(name + ": " + e.message, "bad"); }
  }
  APP.kv.ecg = APP.kv.ecg.slice(-50);
  if (n) { await saveKv("ecg"); setStatus(n + " ECG recording" + (n === 1 ? "" : "s") + " read."); }
  return n;
}
function drawEcg(cv, rec) {
  const c = cv.getContext("2d"), W = cv.width, H = cv.height;
  // paper: 25 mm/s and 10 mm/mV; one small box = 1 mm = 40 ms and 0.1 mV
  const pxPerMm = 6, mmPerS = 25, mmPerMv = 10;
  c.fillStyle = tokenColor("--field"); c.fillRect(0, 0, W, H);
  c.strokeStyle = tokenColor("--chart-grid"); c.lineWidth = 1;
  for (let x = 0; x < W; x += pxPerMm) { c.globalAlpha = (x / pxPerMm) % 5 === 0 ? 1 : 0.4; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  for (let y = 0; y < H; y += pxPerMm) { c.globalAlpha = (y / pxPerMm) % 5 === 0 ? 1 : 0.4; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
  c.globalAlpha = 1;
  const fs = rec.sampleRate, s = rec.samples, n = Math.min(s.length, Math.floor(W / (pxPerMm * mmPerS) * fs));
  const mean = s.slice(0, n).reduce((a, b) => a + b, 0) / Math.max(n, 1);
  c.strokeStyle = tokenColor("--fg"); c.lineWidth = 1.6; c.beginPath();
  for (let i = 0; i < n; i++) {
    const x = i / fs * mmPerS * pxPerMm, y = H / 2 - (s[i] - mean) / 1000 * mmPerMv * pxPerMm;
    if (i) c.lineTo(x, y); else c.moveTo(x, y);
  }
  c.stroke();
}
async function connectCuff() {
  try {
    await connectBle(PulseBLEBP.SERVICE_UUID, PulseBLEBP.CHARACTERISTIC_UUID, async (dv) => {
      const r = PulseBLEBP.decodeBloodPressure(dv);
      if (r.systolicMmHg === null || r.diastolicMmHg === null) return;
      await leaveExample();
      APP.kv.body.push({ date: todayDay(), kg: null, sys: Math.round(r.systolicMmHg), dia: Math.round(r.diastolicMmHg), pulse: r.pulseRate });
      await saveKv("body");
      setStatus("Blood pressure " + Math.round(r.systolicMmHg) + "/" + Math.round(r.diastolicMmHg) + " mmHg saved to the body log.");
    });
    setStatus("Cuff connected. Take a reading on the cuff.");
  } catch (e) { setStatus(e.message || "Could not connect."); }
}
function buildClinicianReport() {
  const c = context();
  const from = c.day - 89;
  const body = new Map();
  for (const b of APP.kv.body) body.set(b.date, Object.assign(body.get(b.date) || {}, b));
  const daily = c.daily.filter((d) => d.date >= from).map((d) => {
    const b = body.get(d.date) || {};
    return { date: SB.dayStr(d.date), rhr: d.rhr, rmssd: d.rmssd, sdnn: d.sdnn, sleep: d.sleep, weight: b.kg || null, sys: b.sys || null, dia: b.dia || null };
  });
  for (const [z, b] of body) if (z >= from && !c.byDay.has(z)) daily.push({ date: SB.dayStr(z), weight: b.kg || null, sys: b.sys || null, dia: b.dia || null });
  if (!daily.length) return null;
  const res = mergedFhir();
  try {
    return PulseReport.buildReport(daily, { generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      labs: res.observations.filter((o) => o.value !== null).slice(-500), medications: res.medications.slice(-200) });
  } catch (e) { setStatus(e.message); return null; }
}
