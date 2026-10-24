// ---------------------------------------------------------------- example athlete (synthetic, never stored)
function exampleExtras(end, rnd) {
  const kv = defaultKv();
  kv.gear = [{ id: "ex-shoe", name: "Example trainers", kind: "shoe", start_km: 310, retire_km: 700 }, { id: "ex-bike", name: "Example road bike", kind: "bike", start_km: 2400, retire_km: null }];
  kv.goals = [{ id: "ex-g1", metric: "distance", period: "week", sport: "run", target: 40000 }, { id: "ex-g2", metric: "time", period: "month", sport: "all", target: 30 * 3600 }, { id: "ex-g3", metric: "sessions", period: "year", sport: "all", target: 250 }];
  const lifts = [["Back squat", 80], ["Deadlift", 100], ["Bench press", 60]];
  for (let w = 0; w < 8; w++) {
    const z = end - 3 - 7 * (7 - w), sets = [];
    for (const [ex, base] of lifts) for (let k = 0; k < 3; k++) sets.push({ exercise: ex, reps: 5, load: base + 2.5 * w + (k === 2 ? 2.5 : 0) });
    kv.strength.push({ id: "ex-st" + w, date: z, name: "Strength, full body", sets });
  }
  for (let k = 0; k < 40; k += 2) kv.body.push({ date: end - 80 + 2 * k, kg: 71.5 - 0.02 * k + (rnd() - 0.5) * 0.6, sys: k % 6 === 0 ? 118 + Math.round(rnd() * 6) : null, dia: k % 6 === 0 ? 76 + Math.round(rnd() * 4) : null });
  for (let z = end - 85; z <= end; z++) kv.journal[z] = { "Alcohol": rnd() < 0.2, "Screen in bed": rnd() < 0.5 };
  kv.cycle = [end - 80, end - 52, end - 23];
  // two days of minute heart rate for the daytime and detection views
  const hr = [];
  for (let z = end - 1; z <= end; z++) for (let m = 6 * 60; m < 22 * 60; m++) {
    const t = z * 1440 + m;
    let v = 58 + 6 * Math.sin(m / 90) + rnd() * 4;
    if (z === end - 1 && m >= 17 * 60 + 10 && m < 17 * 60 + 45) v = 128 + rnd() * 10;
    if (z === end && m >= 12 * 60 && m < 13 * 60) v += 18;
    hr.push([t, Math.round(v), 0]);
  }
  kv.hr = hr;
  return kv;
}
async function startExample() {
  APP.example = true;
  APP.exampleEnd = todayDay();
  setStatus("Generating the example athlete.");
  const res = await WORK.run("example", [APP.exampleEnd, APP.settings]);
  APP.meta.clear(); APP.streams.clear(); APP.daily.clear();
  // The generator writes clock times as UTC; shift them so the example's mornings are local mornings.
  const shift = new Date(APP.exampleEnd * 86400000 + 12 * 3600000).getTimezoneOffset() * 60;
  res.acts.forEach((a) => { for (let i = 0; i < a.t.length; i++) a.t[i] += shift; a.start = a.t[0]; });
  res.acts.forEach((a, i) => {
    const m = makeMeta(a, res.an[i], { source: "example" });
    if (a.sport === "run") m.gear = "ex-shoe"; else if (a.sport === "ride") m.gear = "ex-bike";
    m.row = rowOf(m);
    APP.meta.set(m.id, m); APP.streams.set(m.id, a);
  });
  const rnd = SB.mulberry32(7);
  for (const d of res.daily) {
    // whole-day extras for the example only (steps, energy, vitals, sleep timing)
    d.steps = Math.round(6500 + 5500 * rnd()); d.active_kcal = Math.round(350 + 450 * rnd());
    d.resp = 14.2 + (rnd() - 0.5) * 0.8; d.spo2 = 96.5 + (rnd() - 0.5) * 1.5; d.wrist_temp = 34.6 + (rnd() - 0.5) * 0.4;
    if (d.sleep !== null) { d.in_bed = d.sleep + 0.35 + 0.3 * rnd(); d.wake_min = 375 + Math.round(30 * rnd()); d.bed_min = Math.round((d.wake_min + 1440 - d.in_bed * 60) % 1440); d.bed_min = d.bed_min >= 720 ? d.bed_min - 720 : d.bed_min + 720; }
    APP.daily.set(d.date, d);
  }
  const settingsKeep = APP.settings;
  APP.kv = exampleExtras(APP.exampleEnd, rnd);
  APP.settings = settingsKeep;
  invalidate();
  setStatus("");
}

// ---------------------------------------------------------------- routing
const VIEWS = ["today", "log", "record", "trends", "body", "settings"];
function route() {
  const h = (location.hash || "#today").slice(1).split("/");
  const v = VIEWS.includes(h[0]) ? h[0] : "today";
  for (const x of VIEWS) $("view-" + x).hidden = x !== v;
  for (const x of ["today", "log", "record", "trends", "body"]) { const a = $("nav-" + x); if (x === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
  $("example-badge").hidden = !APP.example;
  try {
    if (v === "today") renderToday();
    else if (v === "log") {
      const sub = ["strength", "journal", "goals"].includes(h[1]) ? h[1] : "acts";
      renderLog(sub, sub === "acts" ? h[1] : null);
    } else if (v === "trends") renderTrends();
    else if (v === "body") renderBody(["ready", "log", "health"].includes(h[1]) ? h[1] : "sleep");
    else if (v === "settings") { renderSettingsForm(); renderAutoNote(); if (typeof renderNetwork === "function") renderNetwork(); }
    else if (v === "record" && typeof renderRecord === "function") renderRecord();
  } catch (e) { setStatus("Something went wrong drawing this view: " + e.message); }
}

// ---------------------------------------------------------------- theme
function applyTheme(t) {
  const root = document.documentElement;
  if (t === "light" || t === "dark") root.setAttribute("data-theme", t); else root.removeAttribute("data-theme");
  for (const x of ["auto", "light", "dark"]) $("theme-" + x).setAttribute("aria-pressed", x === (t || "auto") ? "true" : "false");
  try { localStorage.setItem("pulse.theme", t || "auto"); } catch (e) {}
  const dark = t === "dark" || (t !== "light" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute("content", dark ? "#0b0e1a" : "#f2f3f9");
  if (APP.ready) route();
}

// ---------------------------------------------------------------- wiring
function on(id, ev, fn) { const n = $(id); if (n) n.addEventListener(ev, fn); }
function wire() {
  window.addEventListener("hashchange", route);
  on("log-s-acts", "click", () => { location.hash = "#log"; });
  on("log-s-strength", "click", () => { location.hash = "#log/strength"; });
  on("log-s-journal", "click", () => { location.hash = "#log/journal"; });
  on("log-s-goals", "click", () => { location.hash = "#log/goals"; });
  on("body-s-sleep", "click", () => { location.hash = "#body"; });
  on("body-s-ready", "click", () => { location.hash = "#body/ready"; });
  on("body-s-log", "click", () => { location.hash = "#body/log"; });
  on("body-s-health", "click", () => { location.hash = "#body/health"; });
  on("cal-metric", "change", renderCalendar);
  if (PHONE && PHONE.addEventListener) PHONE.addEventListener("change", () => { if (!$("view-log").hidden) renderCalendar(); });
  on("act-sport", "change", () => { LOG_SHOWN = 40; renderCalendar(); renderActList(); });
  on("act-more", "click", () => { LOG_SHOWN += 60; renderActList(); });
  on("ad-save", "click", async () => {
    const D = APP.detail; if (!D) return;
    const m = D.m;
    m.name = $("ad-name").value.trim().slice(0, 200) || m.name;
    m.gear = $("ad-gear").value || null;
    const r = parseInt($("ad-rpe").dataset.v, 10);
    m.rpe = r >= 1 && r <= 10 ? r : null;
    if (!m.summary_only && D.act) m.an = stripAn(SB.analyze(D.act, APP.settings, m.rpe));
    else if (m.an && m.an.summary) m.an = Object.assign(SB.analyzeSummary(Object.assign({ sport: m.sport }, m.an.summary), APP.settings, m.rpe), { summary: m.an.summary });
    m.row = rowOf(m);
    if (!APP.example) await DB.put("meta", m); else setStatus("Example data is not saved.");
    invalidate(); openActivity(m.id);
  });
  on("ad-gpx", "click", () => { const D = APP.detail; if (D && D.act) saveBlob(new Blob([SB.toGpx(D.act, D.m.name)], { type: "application/gpx+xml" }), SB.dayStr(D.m.day) + "_route.gpx", $("ex-out")); });
  on("ad-gpx-share", "click", () => {
    const D = APP.detail; if (!D || !D.act) return;
    const pts = [];
    for (let i = 0; i < D.act.t.length; i++) if (D.act.lat[i] !== null) pts.push({ lat: D.act.lat[i], lon: D.act.lon[i], t: D.act.t[i], ele: D.act.ele[i], hr: D.act.hr[i] });
    try {
      const tr = PulsePrivacy.trimTrack(pts, { zones: APP.kv.places || [], trimStart: 200, trimEnd: 200 });
      const act = SB.newActivity("export", D.m.name, D.m.sport);
      for (const p of tr.points) { act.t.push(p.t); act.lat.push(p.lat); act.lon.push(p.lon); act.ele.push(p.ele === undefined ? null : p.ele); act.hr.push(p.hr === undefined ? null : p.hr); }
      saveBlob(new Blob([SB.toGpx(act, D.m.name)], { type: "application/gpx+xml" }), SB.dayStr(D.m.day) + "_route_trimmed.gpx", $("ex-out"));
      setStatus("The first and last 200 m are removed (" + tr.removed + " points).");
    } catch (e) { setStatus(e.message); }
  });
  on("ad-delete", "click", () => { $("ad-confirm").hidden = false; $("ad-confirm-yes").focus(); });
  on("ad-confirm-no", "click", () => { $("ad-confirm").hidden = true; });
  on("ad-confirm-yes", "click", async () => {
    const D = APP.detail; if (!D) return;
    APP.meta.delete(D.m.id); APP.streams.delete(D.m.id);
    if (!APP.example) { await DB.del("meta", D.m.id); await DB.del("streams", D.m.id); if (D.m.file) await DB.del("files", D.m.file); }
    APP.detail = null; invalidate(); location.hash = "#log";
  });
  on("seg-make", "click", saveSegment);
  on("st-add", "click", () => $("st-sets").querySelector("tbody").append(strengthRow()));
  on("st-save", "click", saveStrength);
  on("st-ex", "change", renderStrength);
  on("jr-save", "click", saveJournal);
  on("gl-save", "click", addGoal);
  on("gr-save", "click", addGear);
  on("bd-save", "click", saveBody);
  on("cy-save", "click", saveCycle);
  on("cy-overlay", "change", async () => { const v = $("cy-overlay").checked; await ownLog(); APP.kv.cycleOverlay = v; await saveKv("cycleOverlay"); route(); });
  on("yr-select", "change", renderTrends);
  on("plan-ics", "click", () => copyText(bedtimeIcs(), $("plan-ics-out")));
  on("plan-ics-file", "click", () => saveBlob(new Blob([bedtimeIcs()], { type: "text/calendar" }), "pulse-bedtime-" + SB.dayStr(context().day) + ".ics", $("plan-ics-out")));
  on("in-any", "change", (e) => { const f = Array.from(e.target.files); e.target.value = ""; importAny(f); });
  on("in-acts", "change", (e) => { const f = Array.from(e.target.files); e.target.value = ""; importActivityFiles(f); });
  on("in-folder", "change", (e) => { const f = Array.from(e.target.files); e.target.value = ""; importActivityFiles(f); });
  on("in-health", "change", (e) => { if (e.target.files[0]) importHealth(e.target.files[0]); e.target.value = ""; });
  on("in-strava", "change", (e) => { if (e.target.files[0]) importStrava(e.target.files[0]); e.target.value = ""; });
  on("in-whoop", "change", (e) => { const f = Array.from(e.target.files); e.target.value = ""; importWhoop(f); });
  on("in-daily", "change", (e) => { if (e.target.files[0]) importDailyCsv(e.target.files[0]); e.target.value = ""; });
  on("in-dem", "change", (e) => { if (e.target.files[0]) importDem(e.target.files[0]); e.target.value = ""; });
  on("in-backup", "change", (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ""; });
  on("progress-cancel", "click", () => { CANCELLED = true; WORK.cancel(); progress(false); setStatus("Cancelled. Anything already saved stays."); });
  on("ex-json", "click", async () => { setStatus("Building the export."); await saveBlob(new Blob([JSON.stringify(await backupObject())], { type: "application/json" }), "pulse-backup-" + SB.dayStr(todayDay()) + ".json", $("ex-out")); });
  on("ex-zip", "click", exportZip);
  on("ex-csv-acts", "click", () => copyText(activitiesCsv(), $("ex-out")));
  on("ex-csv-daily", "click", () => copyText(dailyCsv(), $("ex-out")));
  on("del-all", "click", () => { $("del-confirm").hidden = false; $("del-no").focus(); });
  on("del-no", "click", () => { $("del-confirm").hidden = true; });
  on("del-yes", "click", deleteAll);
  on("settings-save", "click", saveSettings);
  on("theme-auto", "click", () => applyTheme("auto"));
  on("theme-light", "click", () => applyTheme("light"));
  on("theme-dark", "click", () => applyTheme("dark"));
}
function bedtimeIcs() {
  const c = context(), sl = c.ready.sleep, need = sl ? sl.need : c.s.sleep_base;
  const plan = SB.sleepPlan(need, c.s.wake_min, c.s.sleep_latency);
  let text = null;
  if (typeof PulseICS !== "undefined") {
    try {
      text = PulseICS.sleepEvents({ now: Date.now(), date: SB.dayStr(c.day), bedtime: plan.bedtime, wakeStart: plan.window_start, wakeEnd: plan.wake,
        notes: "Sleep need " + fmtHm(need) + " h." });
    } catch (e) { text = null; }
  }
  return text || icsFallback(c.day, plan);
}
function icsFallback(day, plan) {
  const [y, m, d] = SB.civilFromDays(day);
  const ymd = String(y) + String(m).padStart(2, "0") + String(d).padStart(2, "0"), hm = plan.bedtime.replace(":", "") + "00";
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pulse//Field Tools No. 14//EN", "BEGIN:VEVENT", "UID:pulse-bedtime-" + ymd + "@pulse.local",
    "DTSTAMP:" + ymd + "T000000Z", "DTSTART:" + ymd + "T" + hm, "DURATION:PT15M", "SUMMARY:Bedtime (Pulse)", "END:VEVENT", "END:VCALENDAR"].join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- method and limits
function renderMethod() {
  const b = clear($("method-body"));
  const sec = (h, ps) => { b.append(el("h4", { text: h })); for (const p of ps) b.append(el("p", { text: p })); };
  sec("Where your data lives", ["Everything is stored in this browser's IndexedDB on this device. There are no accounts and no uploads. With every network switch off, the page makes no network requests at all. Export everything as JSON or a zip at any time, and delete everything with one button."]);
  sec("Distance, moving time and climbing", [
    "Distance is the great-circle (haversine) distance between GPS points on a sphere of radius 6,371,008.8 m; without positions the device distance is used.",
    "Moving time uses speed hysteresis: running counts as stopped below 0.5 m/s and moving again from 0.8 m/s (riding 1.0 and 1.5 m/s); stops shorter than 5 s still count as moving, and device timer pauses in FIT files are honoured. All thresholds are in Settings.",
    "Climbing is shown twice: recorded (every rise summed) and corrected (a 5-sample moving average, then reversals smaller than 3 m ignored). Pulse never replaces your device's elevation; with an elevation points file it shows a third, corrected value beside them.",
    "Fastest splits by distance use a sliding window on cumulative distance with interpolated ends, elapsed time, and skip any window that contains a GPS jump faster than 12 m/s (runs) or 30 m/s (rides).",
  ]);
  sec("Load, fitness and form", [
    "Activity load is Banister's exponential heart rate load, summed sample by sample: minutes x HRr x 0.64 e^(1.92 HRr), or 0.86 e^(1.67 HRr) with the female coefficients, where HRr = (HR - rest) / (max - rest) (Banister 1991; Morton, Fitz-Clarke and Banister 1990). Options: Edwards' zone load (minutes in 50 to 100 % of maximum, weighted 1 to 5) and Lucia's three-zone threshold load. Without heart rate, load is effort (1 to 10) x minutes (Foster's session effort).",
    "Long-term load (fitness) and short-term load (fatigue) are exponentially weighted daily load: F(t) = F(t-1) + (L(t) - F(t-1)) x (1 - e^(-1/tau)), tau 42 and 7 days by default (Banister 1975 impulse-response, daily form). Form = fitness minus fatigue carried into the day. Pulse does not claim to match any other service's numbers.",
    "This week against your usual is the mean daily load of the last 7 days over the 21 days before them: uncoupled and descriptive. It is not an injury predictor (Impellizzeri et al. 2020).",
    "Power: weighted power is the fourth root of the mean of the fourth power of 30-second rolling average power (after Coggan); power load = hours x (weighted / FTP)^2 x 100. Grade-adjusted pace uses Minetti et al. 2002's cost of running, Cr(i) = 155.4 i^5 - 30.4 i^4 - 43.3 i^3 + 46.3 i^2 + 19.5 i + 3.6 J/kg/m.",
  ]);
  sec("Readiness inputs", [
    "Each input is compared with your own previous 60 days. HRV: the 7-day mean of ln(rMSSD), shown once there are 3 readings in the week, against the 60-day mean plus or minus 0.5 SD (smallest worthwhile change; Plews et al. 2013; Kiviniemi et al. 2007). rMSSD comes only from beat-to-beat data (FIT hrv messages, Apple's per-beat lists, Whoop exports or a daily CSV). Apple's SDNN is a different measure and is only ever compared with its own baseline.",
    "Resting heart rate: the last 3 days' mean against the 60-day mean plus 1 SD. Sleep: last night against its need = baseline + a share of last week's sleep debt + an optional load term (a heuristic, off by default) - yesterday's naps. Breathing rate, blood oxygen and wrist temperature: against the 60-day median with a robust SD (1.4826 x MAD; when the MAD is 0, 1.253314 x the mean absolute deviation).",
    "Pulse shows how many inputs sit inside your usual range. There is no combined score.",
  ]);
  sec("Estimates", [
    "Energy: Keytel et al. 2005 heart rate equations without VO2max; otherwise METs from the Compendium of Physical Activities x body weight x hours. VO2max from heart rate: 15.3 x HRmax / HRrest (Uth et al. 2004). VDOT: Daniels and Gilbert. Race times: Riegel, T2 = T1 x (D2/D1)^1.06. Fitness age: the age at which the FRIEND registry treadmill 50th percentile (Kaminsky et al. 2022) equals your estimate. One-rep max: Epley and Brzycki. All are estimates.",
  ]);
  sec("Limits", [
    "Files: activity files up to 50 MB, Health exports up to 200 MB, up to 5,000 activities. All-day heart rate keeps the last 120 days. Pulse does not compute sleep stages; it shows the stages your device scored. Daytime stress and workout detection are descriptive rules on heart rate, not measurements of stress. Cycle phases are calendar estimates. Nothing here is medical advice.",
  ]);
}

// ---------------------------------------------------------------- boot
async function boot() {
  let theme = "auto";
  try { theme = localStorage.getItem("pulse.theme") || "auto"; } catch (e) {}
  applyTheme(theme);
  wire();
  renderMethod();
  await loadAll();
  await autoUnits();
  if (!APP.meta.size && !APP.daily.size && !APP.ownEntries) await startExample();
  APP.ready = true;
  if (!APP.dbOk) setStatus("This browser is not letting Pulse store data here (private window or blocked storage). Pulse still works, but nothing is kept after you close it.");
  route();
}
boot();
