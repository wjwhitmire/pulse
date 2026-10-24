// ---------------------------------------------------------------- recording (GPS + Bluetooth heart rate)
const REC = { state: null, watch: null, timer: null, sport: (() => { try { const v = localStorage.getItem("pulse.sport"); return ["run", "ride", "walk"].includes(v) ? v : "run"; } catch (e) { return "run"; } })(), hr: [], hrNow: null, strap: null, wake: null, startMs: null, running: false, hrv: null, hrvBeats: 0 };
async function connectBle(service, characteristic, onValue) {
  if (!navigator.bluetooth) throw SB.err("bt", "This browser has no Web Bluetooth. Use Chrome or Edge on Android, Windows, macOS or Linux; Safari does not support it.");
  const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [service] }] });
  const server = await dev.gatt.connect();
  const ch = await (await server.getPrimaryService(service)).getCharacteristic(characteristic);
  ch.addEventListener("characteristicvaluechanged", (e) => { try { onValue(e.target.value); } catch (err) { /* malformed packet: skip */ } });
  await ch.startNotifications();
  return dev;
}
async function connectStrap() {
  try {
    REC.strap = await connectBle(PulseBLEHR.SERVICE_UUID, PulseBLEHR.CHARACTERISTIC_UUID, (dv) => {
      const p = PulseBLEHR.decodeHeartRate(dv);
      REC.hrNow = p.hr;
      REC.hr.push([Date.now(), p.hr]);
      if (REC.hr.length > 50000) REC.hr.shift();
      if (REC.hrv && p.rrMs.length) { const v = REC.hrv.push(p.rrMs); REC.hrvVal = v; }
      updateRecView();
    });
    setStatus("Heart rate strap connected.");
  } catch (e) { setStatus(e.message || "Could not connect."); }
  renderRecord();
}
function recZone(hr) {
  if (!hr) return 0;
  let z = 0;
  for (const b of SB.zoneBounds(APP.settings)) if (hr >= b) z++;
  return Math.max(1, Math.min(5, z));
}
function renderRecord() {
  const root = clear($("record-root"));
  const grid = el("div", { cls: "grid g-12" });
  root.append(grid);
  const v = REC.state ? PulseRecord.view(REC.state) : null;
  const card = el("article", { cls: "card rec c-12" });
  const segs = el("div", { cls: "seg", role: "group", "aria-label": "Sport" });
  for (const [k, l] of [["run", "Run"], ["ride", "Ride"], ["walk", "Walk"]]) {
    const b = el("button", { type: "button", "aria-pressed": REC.sport === k ? "true" : "false", text: l, disabled: REC.running ? "true" : null });
    b.addEventListener("click", () => { REC.sport = k; try { localStorage.setItem("pulse.sport", k); } catch (e) {} renderRecord(); });
    segs.append(b);
  }
  const chips = el("div", { cls: "rec-status" }, [
    el("span", { cls: "chip" + (REC.running && !(v && v.paused) ? " live" : ""), id: "rec-chip", text: REC.running ? (v && v.paused ? "Paused" : "Recording") : "Ready" }),
    el("span", { cls: "chip", id: "rec-gps" }, [icon("gps"), REC.gpsAcc ? "GPS " + Math.round(REC.gpsAcc) + " m" : "GPS waiting"]),
    el("span", { cls: "chip", id: "rec-strap" }, [icon("bt"), REC.strap ? "Strap connected" : "No strap"]),
  ]);
  const clock = el("div", { cls: "clock" }, [el("p", { cls: "num", id: "rec-clock", text: "0:00" }), el("p", { cls: "label", text: "Moving time" })]);
  const cell = (id, label, keyed) => el("div", { cls: keyed ? "keyed" : "" }, [el("span", { cls: "label", text: label }), el("span", { cls: "num", id, text: "-" })]);
  const recGrid = el("div", { cls: "rec-grid" }, [cell("rec-pace", REC.sport === "ride" ? "Speed now" : "Pace now", true), cell("rec-dist", "Distance"), cell("rec-hr", "Heart rate"), cell("rec-avg", REC.sport === "ride" ? "Avg speed" : "Avg pace")]);
  const zone = el("div", { cls: "rec-zone", id: "rec-zone", role: "img", "aria-label": "Current heart rate zone" });
  for (let z = 1; z <= 5; z++) zone.append(el("span", { cls: "z" + z }));
  const lapB = el("button", { type: "button", cls: "cbtn", id: "rec-lap" }, [el("span", { cls: "disc" }, [icon("lap")]), "Lap"]);
  const mainB = el("button", { type: "button", cls: "cbtn primary", id: "rec-main" }, [el("span", { cls: "disc" }, [icon(REC.running && !(v && v.manualPause) ? "pause" : "play")]), REC.running ? (v && v.manualPause ? "Resume" : "Pause") : "Start"]);
  const finB = el("button", { type: "button", cls: "cbtn", id: "rec-finish" }, [el("span", { cls: "disc" }, [icon("stop")]), "Finish", el("span", { cls: "hold", text: "Hold 1 s" })]);
  card.append(segs, chips, clock, recGrid, zone, el("div", { cls: "controls" }, [lapB, mainB, finB]),
    el("div", { cls: "btn-row" }, [el("button", { type: "button", cls: "btn", text: REC.strap ? "Strap connected" : "Connect a heart rate strap", disabled: REC.strap ? "true" : null, onclick: connectStrap })]),
    el("p", { cls: "muted small", text: "Keep this page open while recording; the screen stays awake where the browser allows it. Positions and heart rate stay on this device. Auto-pause stops the clock below 0.6 m/s." }));
  grid.append(card);
  mainB.addEventListener("click", recMain);
  lapB.addEventListener("click", () => { if (REC.state) { PulseRecord.lap(REC.state); setStatus("Lap " + REC.state.laps.length + " saved."); } });
  let holdT = null;
  const startHold = () => { holdT = setTimeout(recFinish, 1000); };
  const endHold = () => { clearTimeout(holdT); };
  finB.addEventListener("pointerdown", startHold); finB.addEventListener("pointerup", endHold); finB.addEventListener("pointerleave", endHold);
  finB.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.repeat) startHold(); });
  finB.addEventListener("keyup", (e) => { if (e.key === "Enter") endHold(); });
  // live HRV
  const hcard = el("article", { cls: "card c-6", id: "hrv-live" }, [el("div", { cls: "card-h" }, [icon("hrv"), el("h3", { text: "Morning HRV reading" })]),
    el("p", { cls: "muted", text: "Lie still for 3 to 5 minutes with a chest strap that sends beat-to-beat intervals. Pulse computes rMSSD from the beats and can save it as today's reading." }),
    el("p", { cls: "live-hrv" }, [el("span", { cls: "num", id: "hrv-live-val", text: "-" }), el("span", { cls: "muted", text: " ms rMSSD, rolling 60 s" })]),
    el("div", { cls: "btn-row" }, [
      el("button", { type: "button", cls: "btn", text: REC.hrv ? "Reading..." : "Start reading", onclick: () => { if (!REC.strap) { connectStrap(); return; } REC.hrv = PulseBLEHR.rmssdWindow({}); REC.hrvVal = null; renderRecord(); } }),
      el("button", { type: "button", cls: "btn primary", text: "Save as today's HRV", onclick: saveLiveHrv })])]);
  grid.append(hcard);
  renderPlanner(grid);
  updateRecView();
}
function updateRecView() {
  if (!$("rec-clock")) return;
  const v = REC.state ? PulseRecord.view(REC.state) : null;
  const ride = REC.sport === "ride";
  $("rec-clock").textContent = fmtDur(v ? v.movingTime / 1000 : 0);
  $("rec-dist").textContent = v ? (v.distance / UNIT().len).toFixed(2) : "0.00";
  const pace = v && v.pace ? v.pace : null, avg = v && v.avgPace ? v.avgPace : null;
  // pace is seconds per km; speed shown in the chosen unit per hour
  $("rec-pace").textContent = pace ? (ride ? (3600 / pace * 1000 / UNIT().len).toFixed(1) : fmtDur(pace * UNIT().len / 1000)) : "-";
  $("rec-avg").textContent = avg ? (ride ? (3600 / avg * 1000 / UNIT().len).toFixed(1) : fmtDur(avg * UNIT().len / 1000)) : "-";
  const chip = $("rec-chip");
  if (chip) { const paused = REC.running && v && v.paused; chip.textContent = REC.running ? (paused ? (v.manualPause ? "Paused" : "Auto-paused") : "Recording") : "Ready"; chip.classList.toggle("live", !!(REC.running && !paused)); }
  const hrEl = $("rec-hr"), z = recZone(REC.hrNow);
  clear(hrEl).append(REC.hrNow ? String(REC.hrNow) : "-");
  if (z) { const chip = el("span", { cls: "zchip", text: "Z" + z }); chip.style.background = "var(--z" + z + ")"; hrEl.append(chip); }
  const zs = $("rec-zone").children;
  for (let k = 0; k < zs.length; k++) zs[k].classList.toggle("on", k + 1 === z);
  if ($("hrv-live-val")) $("hrv-live-val").textContent = REC.hrvVal && REC.hrvVal.rmssd ? REC.hrvVal.rmssd.toFixed(0) : "-";
}
async function recMain() {
  if (!REC.running) {
    if (!navigator.geolocation) { setStatus("This browser has no location sensor access; heart rate only will be recorded."); }
    REC.state = PulseRecord.createRecorder({ sport: REC.sport === "walk" ? "walk" : REC.sport, splitDistance: UNIT().len });
    REC.running = true; REC.startMs = Date.now(); REC.hr = REC.hr.filter((x) => x[0] > Date.now() - 1000);
    try { if (navigator.wakeLock) REC.wake = await navigator.wakeLock.request("screen"); } catch (e) { REC.wake = null; }
    if (navigator.geolocation) {
      REC.watch = navigator.geolocation.watchPosition((p) => {
        REC.gpsAcc = p.coords.accuracy;
        PulseRecord.addFix(REC.state, { t: p.timestamp, lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude });
        updateRecView();
      }, (e) => setStatus("Location: " + e.message), { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    }
    REC.timer = setInterval(updateRecView, 1000);
  } else {
    const v = PulseRecord.view(REC.state);
    PulseRecord.setManualPause(REC.state, !v.manualPause);
  }
  renderRecord();
}
async function recFinish() {
  if (!REC.running) return;
  if (REC.watch !== null && navigator.geolocation) navigator.geolocation.clearWatch(REC.watch);
  clearInterval(REC.timer);
  try { if (REC.wake) await REC.wake.release(); } catch (e) {}
  REC.running = false; REC.watch = null;
  // The stretch after the last lap button press is the final lap, as on a watch.
  if (REC.state.laps.length && REC.state.distance - REC.state.lapStart.distance >= 10) PulseRecord.lap(REC.state);
  const sm = PulseRecord.summary(REC.state);
  const act = SB.newActivity("recorded", "", REC.sport === "ride" ? "ride" : "run");
  const hr = REC.hr.filter((x) => x[0] >= REC.startMs);
  const hrAt = (ms) => { let best = null, bd = 5001; for (const [t, v] of hr) { const d = Math.abs(t - ms); if (d < bd) { bd = d; best = v; } } return best; };
  if (sm.track.length >= 2) {
    for (const p of sm.track) { act.t.push(p.t / 1000); act.lat.push(p.lat); act.lon.push(p.lon); act.ele.push(p.ele); act.hr.push(hrAt(p.t)); act.cad.push(null); act.pwr.push(null); act.dist.push(null); }
  } else if (hr.length >= 2) {
    for (const [t, v] of hr) { act.t.push(t / 1000); act.lat.push(null); act.lon.push(null); act.ele.push(null); act.hr.push(v); act.cad.push(null); act.pwr.push(null); act.dist.push(null); }
  }
  act.laps = sm.lapList.map((l) => ({ start: l.startT / 1000, elapsed: l.elapsed / 1000, timer: l.movingTime / 1000, distance: l.distance, avg_hr: null, max_hr: null }));
  REC.state = null;
  if (act.t.length < 2) { setStatus("Nothing was recorded: no GPS fixes and no heart rate."); renderRecord(); return; }
  act.start = act.t[0];
  await leaveExample();
  const r = await saveActivity(act, null, { source: "recorded" });
  invalidate();
  setStatus("Saved.");
  location.hash = "#log/" + r.id;
}
async function saveLiveHrv() {
  const v = REC.hrvVal;
  if (!v || !v.rmssd) { setStatus("No reading yet. Start a reading and keep still for a few minutes."); return; }
  await leaveExample();
  await mergeDaily([Object.assign(SB.blankDay(todayDay()), { rmssd: v.rmssd })]);
  invalidate();
  setStatus("Saved rMSSD " + v.rmssd.toFixed(0) + " ms as today's reading.");
}
