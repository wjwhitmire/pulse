// ---------------------------------------------------------------- Body: sleep, readiness, body log
function ring(node, pct) {
  clear(node);
  const r = 84, L = 2 * Math.PI * r, f = Math.max(0, Math.min(1, pct / 100));
  const s = svg("svg", { viewBox: "0 0 200 200", "aria-hidden": "true" });
  s.append(svg("circle", { class: "r-track", cx: 100, cy: 100, r, fill: "none", "stroke-width": 16 }));
  const fill = svg("circle", { class: "r-fill", cx: 100, cy: 100, r, fill: "none", "stroke-width": 16, "stroke-linecap": "round" });
  fill.style.setProperty("--len", (L * f).toFixed(1));
  if (f > 0) s.append(fill);
  node.append(s, el("div", { cls: "r-read" }, [el("span", { cls: "num", text: Math.round(pct) + "%" }), el("span", { cls: "label", text: "of need" })]));
  node.setAttribute("aria-label", "Slept " + Math.round(pct) + " percent of last night's need");
}
function renderBody(sub) {
  const subs = { sleep: "body-sleep", ready: "body-ready", log: "body-log", health: "body-health" };
  for (const k of Object.keys(subs)) { $(subs[k]).hidden = k !== sub; $("body-s-" + k).setAttribute("aria-pressed", k === sub ? "true" : "false"); }
  $("body-h").textContent = sub === "sleep" ? "Sleep" : sub === "ready" ? "Readiness inputs" : sub === "log" ? "Body log" : "Health records";
  if (sub === "sleep") renderSleep();
  else if (sub === "ready") renderReadiness();
  else if (sub === "log") renderBodyLog();
  else if (typeof renderHealth === "function") renderHealth();
}
function renderSleep() {
  const c = context(), sl = c.ready.sleep, d = c.byDay.get(c.day) || {};
  if (sl) {
    ring($("sleep-ring"), sl.ratio * 100);
    $("sleep-call").textContent = `You slept ${fmtHm(sl.hours)} against a ${fmtHm(sl.need)} need. ` + (sl.ratio >= 0.95 ? "That covers it." : sl.ratio >= 0.85 ? "Close to enough." : "Short of what you need; an earlier night helps more than a nap.");
    const eq = clear($("sleep-eq"));
    const term = (v, l, cls) => el("span", { cls: "term" + (cls ? " " + cls : "") }, [el("b", { text: fmtHm(v) }), el("span", { text: l })]);
    eq.append(term(sl.base, "baseline"), el("span", { cls: "op", text: "+" }), term(c.s.sleep_debt_share * sl.debt, "debt share"), el("span", { cls: "op", text: "+" }), term(sl.load_term, "load (heuristic)"),
      el("span", { cls: "op", text: "-" }), term(sl.nap, "nap"), el("span", { cls: "op", text: "=" }), term(sl.need, "need", "total"));
  } else {
    clear($("sleep-ring")); clear($("sleep-eq"));
    $("sleep-call").textContent = "No sleep recorded for last night. Import an Apple Health export, a Whoop export or a daily CSV.";
  }
  const stg = clear($("sleep-stages"));
  if (d.stages) {
    const items = [["Awake", "s-awake", d.in_bed && d.sleep ? Math.max(0, d.in_bed - d.sleep) : null], ["REM", "s-rem", d.stages.rem], ["Light", "s-light", d.stages.core + d.stages.unspecified], ["Deep", "s-deep", d.stages.deep]];
    for (const [l, cls, v] of items) {
      const sw = el("i"); sw.style.background = "var(--" + cls + ")";
      stg.append(el("div", null, [el("span", { cls: "sw" }, [sw, l]), numEl(v === null ? "-" : fmtHm(v), "h")]));
    }
  }
  // sleep vs need, last 30 nights
  const xs = [], ys = [], need = [];
  for (let z = c.day - 29; z <= c.day; z++) {
    const r = c.byDay.get(z);
    xs.push(z); ys.push(r && r.sleep !== null ? r.sleep : null);
    const rr = r && r.sleep !== null ? SB.readiness(c.daily, z, c.s, c.loads) : null;
    need.push(rr && rr.sleep ? rr.sleep.need : null);
  }
  chart($("sleep-chart"), { x: xs, bars: [{ y: ys, cur: xs.length - 1 }], series: [{ y: need, cls: "s-ref" }], overlays: cycleOverlays(), xfmt: fmtDayShort, yfmt: (v) => v.toFixed(0) + " h" });
  const eff = SB.efficiency(d), cons = SB.consistency(c.daily, c.day);
  stats($("sleep-stats"), [
    ["In bed", d.in_bed ? fmtHm(d.in_bed) : "-", "h"], ["Efficiency", eff ? (eff * 100).toFixed(0) : "-", "%"],
    ["Consistency", cons ? cons.score.toFixed(0) : "-", "of 100"],
    ["Bedtime", d.bed_min !== null && d.bed_min !== undefined ? SB.fmtClock(d.bed_min + 720) : "-", ""],
    ["Wake", d.wake_min !== null && d.wake_min !== undefined ? SB.fmtClock(d.wake_min) : "-", ""],
    ["Nap yesterday", c.byDay.get(c.day - 1) && c.byDay.get(c.day - 1).nap ? fmtHm(c.byDay.get(c.day - 1).nap) : "-", "h"],
  ]);
}
function renderReadiness() {
  const c = context(), r = c.ready;
  const metric = r.hrv ? r.hrv.metric : "rmssd";
  $("hrv-h").textContent = metric === "rmssd" ? "HRV, rMSSD, ms" : "HRV, SDNN, ms (kept apart from rMSSD)";
  const xs = [], dots = [], roll = [], lo = [], hi = [];
  for (let z = c.day - 89; z <= c.day; z++) {
    xs.push(z);
    const dd = c.byDay.get(z);
    dots.push(dd && dd[metric] ? dd[metric] : null);
    const rr = SB.readiness(c.daily, z, c.s, c.loads);
    const h = rr.hrv && rr.hrv.metric === metric ? rr.hrv : null;
    roll.push(h && h.roll !== null ? Math.exp(h.roll) : null);
    lo.push(h ? Math.exp(h.lo) : null); hi.push(h ? Math.exp(h.hi) : null);
  }
  chart($("hrv-chart"), { x: xs, tall: true, band: { lo, hi }, series: [{ y: dots, dots: true }, { y: roll, cls: "s-hrv" }], overlays: cycleOverlays(), xfmt: fmtDayShort, yfmt: (v) => String(Math.round(v)) });
  $("hrv-hint").textContent = "Your usual range is the 60-day mean of daily ln(HRV) plus or minus half a standard deviation (smallest worthwhile change, after Plews et al. 2013); the line is the 7-day mean, shown once there are 3 readings in the week. rMSSD comes from beat-to-beat data only; Apple's SDNN is shown on its own scale, never mixed in.";
  const rx = [], ry = [], rlo = [], rhi = [];
  for (let z = c.day - 89; z <= c.day; z++) {
    rx.push(z); const dd = c.byDay.get(z); ry.push(dd && dd.rhr ? dd.rhr : null);
    const rr = SB.readiness(c.daily, z, c.s, c.loads);
    if (rr.rhr) { const w = Math.max(rr.rhr.sd || 0, 1); rlo.push(rr.rhr.mean - w); rhi.push(rr.rhr.mean + w); } else { rlo.push(null); rhi.push(null); }
  }
  chart($("rhr-chart"), { x: rx, band: { lo: rlo, hi: rhi }, series: [{ y: ry, cls: "s-hr" }], xfmt: fmtDayShort, yfmt: (v) => String(Math.round(v)) });
  const vit = [["Breathing rate", "resp", "/min", 1], ["Blood oxygen", "spo2", "%", 1], ["Wrist temperature", "wrist_temp", "C", 2], ["Resting HR", "rhr", "bpm", 0], ["Steps", "steps", "", 0]];
  table($("vitals-table"), ["Signal", "Today", "Usual", "z"], vit.map(([l, k, u, dp]) => {
    const v = SB.vital(c.daily, c.day, k);
    if (v && v.no_variation) return [l + (u ? " (" + u + ")" : ""), v.value.toFixed(dp), v.median.toFixed(dp), el("span", { cls: "muted", text: "Not enough variation to compare" })];
    return v ? [l + (u ? " (" + u + ")" : ""), v.flag ? el("b", { text: v.value.toFixed(dp) }) : v.value.toFixed(dp), v.median.toFixed(dp), v.z.toFixed(1)] : [l, "-", "-", "-"];
  }), { cls: ["txt", "r", "r", "r"] });
  const hist = [];
  for (let z = c.day; z > c.day - 14; z--) {
    const rr = SB.readiness(c.daily, z, c.s, c.loads);
    const mark = (txt, out) => (out ? el("b", { text: txt + (out === "low" ? " low" : " high") }) : txt);
    const h = rr.hrv && rr.hrv.roll !== null ? mark(Math.exp(rr.hrv.roll).toFixed(0), rr.hrv.status === "low" ? "low" : rr.hrv.status === "high" ? "high" : null) : "-";
    const k = rr.rhr && rr.rhr.recent !== null ? mark(rr.rhr.recent.toFixed(0), rr.rhr.status === "high" ? "high" : null) : "-";
    const sv = rr.sleep ? mark((rr.sleep.ratio * 100).toFixed(0) + "%", rr.sleep.status === "short" ? "low" : null) : "-";
    const avail = (rr.hrv && rr.hrv.roll !== null ? 1 : 0) + (rr.rhr && rr.rhr.recent !== null ? 1 : 0) + (rr.sleep ? 1 : 0);
    hist.push([fmtDayShort(z), h, k, sv, avail ? (avail - rr.flags.length) + " of " + avail : "-"]);
  }
  table($("ready-history"), ["Day", "HRV", "RHR", "Sleep", "Inside"], hist, { cls: ["", "r", "r", "r", "r"] });
}
function renderBodyLog() {
  const c = context(), body = APP.kv.body;
  $("bd-date").value = $("bd-date").value || inputFromDay(c.day);
  const w = SB.weightTrend(body.filter((e) => e.kg));
  if (w.series.length >= 2) chart($("bd-chart"), { x: w.series.map((p) => p[0]), series: [{ y: w.series.map((p) => p[1]), dots: true }, { y: w.series.map((p) => p[2]), cls: "s-1" }], xfmt: fmtDayShort, yfmt: (v) => v.toFixed(1) });
  else { const n = clear($("bd-chart")); n.className = ""; n.append(el("p", { cls: "empty-note", text: "Two weight entries draw a trend." })); }
  const bp = SB.bpSummary(body, c.day);
  const parts = [];
  if (w.series.length) parts.push(`Weight trend ${w.series[w.series.length - 1][2].toFixed(1)} kg (7-day mean)` + (w.change30 !== null ? `, ${w.change30 >= 0 ? "+" : ""}${w.change30.toFixed(1)} kg over 30 days.` : "."));
  if (bp.d7) parts.push(`Blood pressure, last 7 days: ${bp.d7[0].toFixed(0)}/${bp.d7[1].toFixed(0)} mmHg from ${bp.d7[2]} readings.`);
  if (bp.d30) parts.push(`Last 30 days: ${bp.d30[0].toFixed(0)}/${bp.d30[1].toFixed(0)} mmHg from ${bp.d30[2]} readings.`);
  $("bd-text").textContent = parts.join(" ") || "No entries yet.";
  const cy = SB.cyclePhase(APP.kv.cycle, c.day, 28);
  $("cy-text").textContent = cy ? `Cycle day ${cy.cycle_day} of about ${cy.length.toFixed(0)}; estimated phase: ${cy.phase}. Next start expected around ${fmtDay(cy.next_start)}.` : "No period starts entered.";
  $("cy-overlay").checked = !!APP.kv.cycleOverlay;
}
async function saveBody() {
  const z = dayFromInput($("bd-date").value);
  if (z === null) { setStatus("Pick a day."); return; }
  const kg = parseFloat($("bd-kg").value), sys = parseFloat($("bd-sys").value), dia = parseFloat($("bd-dia").value);
  const e = { date: z, kg: kg >= 20 && kg <= 400 ? kg : null, sys: sys >= 60 && sys <= 260 ? sys : null, dia: dia >= 30 && dia <= 160 ? dia : null };
  if (!e.kg && !(e.sys && e.dia)) { setStatus("Enter a weight, or both blood pressure numbers."); return; }
  if (e.sys && e.dia && e.sys <= e.dia) { setStatus("The first blood pressure number (systolic) is the higher one. Check the order."); return; }
  if (!e.sys || !e.dia) { e.sys = null; e.dia = null; }
  await ownLog();
  APP.kv.body.push(e);
  await saveKv("body");
  setStatus("Entry saved."); renderBodyLog();
  if (e.kg) { invalidate(); await applyAuto(); }
}
async function saveCycle() {
  const z = dayFromInput($("cy-date").value);
  if (z === null) { setStatus("Pick the first day of the period."); return; }
  await ownLog();
  if (!APP.kv.cycle.includes(z)) APP.kv.cycle.push(z);
  APP.kv.cycle.sort((a, b) => a - b);
  await saveKv("cycle");
  renderBodyLog();
}
