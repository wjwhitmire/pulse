// ---------------------------------------------------------------- shared derived context
let CTX = null;
function invalidate() { CTX = null; }
function refDay() { return APP.example ? APP.exampleEnd : todayDay(); }
function dailyList() { return Array.from(APP.daily.values()).sort((a, b) => a.date - b.date); }
function context() {
  if (CTX) return CTX;
  const s = APP.settings, R = rows(), day = refDay(), daily = dailyList();
  const loads = SB.dailyLoads(R.map((r) => [r.day, r.load]));
  const first = R.length ? Math.min(...R.map((r) => r.day)) : day - 1;
  const start = Math.max(first, day - 730);
  const series = SB.loadSeries(loads, start, day, s.fit_tau, s.fat_tau);
  const ready = SB.readiness(daily, day, s, loads);
  CTX = { s, R, day, daily, loads, series, ready, byDay: new Map(daily.map((d) => [d.date, d])) };
  return CTX;
}

// ---------------------------------------------------------------- horizons (signature component)
function horizonsFor(c) {
  const out = [], r = c.ready, s = c.s;
  if (r.hrv && r.hrv.roll !== null) {
    const h = r.hrv, v = Math.exp(h.roll), lo = Math.exp(h.lo), hi = Math.exp(h.hi), base = Math.exp(h.mean);
    out.push({ key: "hrv", icon: "hrv", name: h.metric === "rmssd" ? "Overnight HRV" : "HRV (SDNN)", v, lo, hi, base, unit: "ms", dp: 0,
      metricNote: h.metric === "rmssd" ? "rMSSD, 7-day mean" : "SDNN, 7-day mean; kept apart from rMSSD" });
  }
  if (r.rhr && r.rhr.recent !== null) {
    const k = r.rhr, w = Math.max(k.sd || 0, 1);
    out.push({ key: "rhr", icon: "rhr", name: "Resting HR", v: k.recent, lo: k.mean - w, hi: k.mean + w, base: k.mean, unit: "bpm", dp: 0, flagHigh: true });
  }
  if (r.sleep) {
    const ratios = [];
    for (let z = c.day - 60; z < c.day; z++) {
      const d = c.byDay.get(z);
      if (!d || d.sleep === null || d.sleep === undefined) continue;
      const rr = SB.readiness(c.daily, z, s, c.loads);
      if (rr.sleep) ratios.push(rr.sleep.ratio * 100);
    }
    const m = ratios.length >= 7 ? SB.mean(ratios) : 100, sdv = ratios.length >= 7 ? Math.max(SB.sd(ratios), 3) : 10;
    out.push({ key: "sleep", icon: "sleep", name: "Sleep vs need", v: r.sleep.ratio * 100, lo: 85, hi: Math.max(m + sdv, 100), base: Math.max(m, 85), unit: "%", dp: 0 });
  }
  const vr = SB.vital(c.daily, c.day, "resp");
  if (vr && !vr.no_variation) out.push({ key: "resp", icon: "breath", name: "Breathing rate", v: vr.value, lo: vr.median - 2 * vr.rsd, hi: vr.median + 2 * vr.rsd, base: vr.median, unit: "/min", dp: 1 });
  for (const h of out) {
    h.state = h.v < h.lo ? "below" : h.v > h.hi ? "above" : "within";
    if (h.key === "sleep") h.state = h.v < 85 ? "below" : "within";
  }
  return out;
}
function horizonEl(h) {
  const lo = Math.min(h.lo, h.v, h.base), hi = Math.max(h.hi, h.v, h.base), pad = Math.max((hi - lo) * 0.25, (h.hi - h.lo) * 0.5) || 1;
  const a = lo - pad, b = hi + pad, P = (x) => ((x - a) / (b - a) * 100).toFixed(1) + "%";
  const fmt = (x) => x.toFixed(h.dp);
  const stateTxt = h.state === "within" ? "Within usual" : h.state === "above" ? "Above usual" : "Below usual";
  const track = el("div", { cls: "h-track", role: "img", "aria-label": `${h.name} ${fmt(h.v)} ${h.unit}, usual ${fmt(h.lo)} to ${fmt(h.hi)}, ${stateTxt}` },
    [el("i", { cls: "h-band" }), el("i", { cls: "h-base" }), el("i", { cls: "h-dot" })]);
  track.style.setProperty("--lo", P(h.lo)); track.style.setProperty("--hi", P(h.hi));
  track.style.setProperty("--base", P(h.base)); track.style.setProperty("--v", P(h.v));
  const st = el("span", { cls: "h-state" }, [h.state === "within" ? icon("check") : icon(h.state === "above" ? "up" : "down"), stateTxt]);
  return el("li", { cls: "horizon" + (h.state === "within" ? "" : " out") }, [
    el("div", { cls: "h-top" }, [el("span", { cls: "h-name" }, [icon(h.icon), h.name]), el("span", { cls: "h-val" }, [numEl(fmt(h.v), h.unit)])]),
    track,
    el("div", { cls: "h-foot" }, [el("span", { text: "Usual " + fmt(h.lo) + " to " + fmt(h.hi) }), st]),
  ]);
}

// ---------------------------------------------------------------- gauge
function suggestedRange(intent, fitness) {
  const f = Math.max(fitness, 1);
  if (intent === "Recover") return [0, 0.5 * f];
  if (intent === "Maintain") return [0.75 * f, 1.25 * f];
  return [1.25 * f, 2.0 * f];
}
function gauge(node, value, lo, hi) {
  clear(node);
  const max = Math.max(hi * 1.25, value * 1.1, 10), A0 = 150, SPAN = 240, R = 82, LEN = SPAN * Math.PI / 180 * R;
  const pt = (deg, r) => [100 + r * Math.cos(deg * Math.PI / 180), 100 + r * Math.sin(deg * Math.PI / 180)];
  const arc = (d0, d1, r) => { const [x0, y0] = pt(d0, r), [x1, y1] = pt(d1, r); return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${d1 - d0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`; };
  const f = Math.min(1, value / max), fl = Math.min(1, lo / max), fh = Math.min(1, hi / max);
  const s = svg("svg", { viewBox: "0 0 200 200" });
  s.append(svg("path", { class: "g-track", d: arc(A0, A0 + SPAN, R), fill: "none", "stroke-width": 14, "stroke-linecap": "round" }));
  if (fh > fl) s.append(svg("path", { class: "g-band", d: arc(A0 + SPAN * fl, A0 + SPAN * fh, 97), fill: "none", "stroke-width": 4, "stroke-linecap": "round" }));
  for (let k = 0; k <= 8; k++) { const [x1, y1] = pt(A0 + 30 * k, 66), [x2, y2] = pt(A0 + 30 * k, 70); s.append(svg("line", { class: "g-tick", x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2), "stroke-width": 1.5, "stroke-linecap": "round" })); }
  if (f > 0) {
    const fill = svg("path", { class: "g-fill", d: arc(A0, A0 + SPAN, R), fill: "none", "stroke-width": 14, "stroke-linecap": "round" });
    fill.style.setProperty("--len", (LEN * f).toFixed(1));
    s.append(fill);
    const [tx, ty] = pt(A0 + SPAN * f, R);
    s.append(svg("circle", { class: "g-tip", cx: tx.toFixed(2), cy: ty.toFixed(2), r: 5, "stroke-width": 4 }));
  }
  node.append(s, el("div", { cls: "g-read" }, [el("span", { cls: "label", text: "Load today" }), el("span", { cls: "num", text: String(Math.round(value)) }),
    el("span", { cls: "g-sub" }, ["Suggested", el("br"), Math.round(lo) + " to " + Math.round(hi)])]));
  node.setAttribute("aria-label", `Load today ${Math.round(value)}, suggested range ${Math.round(lo)} to ${Math.round(hi)}`);
}

// ---------------------------------------------------------------- sparkline metric card
function sparkCard(label, ic, value, unit, delta, ys, band) {
  const card = el("article", { cls: "card metric" }, [el("p", { cls: "m-label" }, [icon(ic), label]), numEl(value, unit), el("p", { cls: "m-delta", text: delta })]);
  const vals = ys.filter((v) => v !== null && Number.isFinite(v));
  if (vals.length >= 2) {
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (band) { lo = Math.min(lo, band[0]); hi = Math.max(hi, band[1]); }
    if (hi === lo) hi = lo + 1;
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const n = ys.length, X = (i) => (i / (n - 1) * 100).toFixed(2), Y = (v) => ((hi - v) / (hi - lo) * 40).toFixed(2);
    const s = svg("svg", { class: "spark", viewBox: "0 0 100 40", preserveAspectRatio: "none", "aria-hidden": "true" });
    if (band) s.append(svg("rect", { class: "bd", x: 0, y: Y(band[1]), width: 100, height: (Y(band[0]) - Y(band[1])).toFixed(2) }));
    let d = "", firstI = null, lastI = null;
    ys.forEach((v, i) => { if (v === null || !Number.isFinite(v)) return; d += (d ? " L" : "M") + X(i) + "," + Y(v); if (firstI === null) firstI = i; lastI = i; });
    s.append(svg("path", { class: "ar", d: d + ` L${X(lastI)},40 L${X(firstI)},40 Z` }), svg("path", { class: "ln", d }));
    const end = el("i", { cls: "spark-end" });
    end.style.left = "calc(" + X(lastI) + "% - " + (lastI === n - 1 ? 4 : 0) + "px)"; end.style.top = (Y(ys[lastI]) / 40 * 100).toFixed(1) + "%";
    card.append(el("div", { cls: "spark-wrap" }, [s, end]));
  }
  return card;
}

function thumbSvg(thumb) {
  const s = svg("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true" });
  if (thumb && thumb.length > 1) {
    const lat0 = thumb[0][0], lon0 = thumb[0][1];
    const xy = thumb.map(([la, lo]) => SB.projectLocal(la, lo, lat0, lon0));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of xy) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const span = Math.max(x1 - x0, y1 - y0, 1), k = 80 / span, ox = 50 - (x0 + x1) / 2 * k, oy = 50 + (y0 + y1) / 2 * k;
    const d = xy.map(([x, y], i) => (i ? "L" : "M") + (ox + x * k).toFixed(1) + "," + (oy - y * k).toFixed(1)).join("");
    s.append(svg("path", { d, fill: "none", stroke: "var(--route)", "stroke-width": 4, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  }
  return s;
}
function zmini(zones) {
  const z = el("div", { cls: "zmini", role: "img", "aria-label": "Time in heart rate zones" });
  if (zones) zones.slice(1).forEach((v, i) => { const sp = el("span", { cls: "z" + (i + 1) }); sp.style.flex = String(v); z.append(sp); });
  return z;
}
function actCard(m) {
  const an = m.an || {};
  const a = el("a", { cls: "card act", href: "#log/" + m.id }, [
    el("div", { cls: "thumb" }, [thumbSvg(m.thumb)]),
    el("div", { style: "min-width:0" }, [
      el("p", { cls: "act-title", text: m.name }),
      el("p", { cls: "act-meta" }, [icon(m.sport === "ride" ? "ride" : m.sport === "run" ? "run" : "time"), fmtDay(m.day) + ", " + fmtClockTs(m.start)]),
      el("div", { cls: "trio" }, [
        el("div", null, [el("span", { cls: "label", text: "Distance" }), numEl((an.distance / UNIT().len).toFixed(1), UNIT().name)]),
        el("div", null, [el("span", { cls: "label", text: m.sport === "run" ? "Pace" : "Time" }), numEl(m.sport === "run" ? fmtDur(an.speed ? UNIT().len / an.speed : null) : fmtDur(an.moving), m.sport === "run" ? "/" + UNIT().name : "")]),
        el("div", null, [el("span", { cls: "label", text: "Load" }), numEl(an.load === null || an.load === undefined ? "-" : String(Math.round(an.load)))]),
      ]),
      zmini(an.hr ? an.hr.zones : null),
    ]),
  ]);
  return a;
}

// ---------------------------------------------------------------- Today
function renderToday() {
  const c = context(), s = c.s;
  const [ty, tm, td] = SB.civilFromDays(c.day);
  const WD = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][(c.day + 3) % 7];
  const MF = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  $("today-date").textContent = WD + " " + td + " " + MF[tm - 1] + (ty !== SB.civilFromDays(todayDay())[0] ? " " + ty : "");
  const hs = horizonsFor(c);
  const ul = clear($("horizons"));
  hs.forEach((h) => ul.append(horizonEl(h)));
  const inside = hs.filter((h) => h.state === "within").length;
  $("ready-count").textContent = hs.length ? inside + " of " + hs.length : "No data";
  $("ready-of").textContent = hs.length ? "inside your usual range" : "import HRV, resting HR or sleep to see your usual range";
  const sug = SB.suggest(c.R, c.ready, c.series, c.day);
  const call = clear($("ready-call"));
  const flagged = new Set(c.ready.flags);
  const out = hs.filter((h) => h.state !== "within").sort((a, b) => (flagged.has(b.key) ? 1 : 0) - (flagged.has(a.key) ? 1 : 0));
  if (!hs.length) call.append("Import an Apple Health export, a Whoop export or a daily CSV. Pulse needs about two weeks of mornings to learn your usual range.");
  else if (!out.length) call.append("Every input is inside your usual range. " + (sug.intent === "Build" ? "A good day for a harder session." : "Load is still high, so keep today steady."));
  else {
    const h = out[0], diff = Math.abs(h.v - h.base);
    const words = h.key === "sleep" ? `Sleep was ${Math.round(h.v)}% of last night's need` : `${h.name} is ${diff.toFixed(h.dp)} ${h.unit === "%" ? "points" : h.unit} ${h.state} usual`;
    call.append(el("b", { text: words }), ", " + (sug.intent === "Recover" ? "so an easy day or rest fits." : "so keep the effort steady and the warm-up easy."));
  }
  const fit = c.series.fitness.length ? c.series.fitness[c.series.fitness.length - 1] : 0;
  const [glo, ghi] = suggestedRange(sug.intent, fit);
  gauge($("load-gauge"), c.loads.get(c.day) || 0, glo, ghi);
  // metric cards
  const mt = clear($("today-metrics"));
  const last14 = (key, f) => { const o = []; for (let z = c.day - 13; z <= c.day; z++) { const d = c.byDay.get(z); o.push(d && d[key] !== null && d[key] !== undefined ? f(d[key]) : null); } return o; };
  if (c.ready.hrv) {
    const h = c.ready.hrv, key = h.metric;
    const ser = [];
    for (let z = c.day - 13; z <= c.day; z++) { const w = []; for (let q = z - 6; q <= z; q++) { const d = c.byDay.get(q); if (d && d[key]) w.push(Math.log(d[key])); } ser.push(w.length >= 3 ? Math.exp(SB.mean(w)) : null); }
    const v = h.roll !== null ? Math.exp(h.roll) : null;
    mt.append(sparkCard("HRV, 7-day", "hrv", v === null ? "-" : v.toFixed(0), "ms", v === null ? "Not enough readings this week" : (v - Math.exp(h.mean) >= 0 ? "+" : "") + (v - Math.exp(h.mean)).toFixed(0) + " vs your usual", ser, [Math.exp(h.lo), Math.exp(h.hi)]));
  }
  if (c.ready.rhr) {
    const k = c.ready.rhr, w = Math.max(k.sd || 0, 1);
    mt.append(sparkCard("Resting HR", "rhr", k.recent === null ? "-" : k.recent.toFixed(0), "bpm", k.recent === null ? "No reading in 3 days" : (k.recent - k.mean >= 0 ? "+" : "") + (k.recent - k.mean).toFixed(0) + " vs your usual", last14("rhr", (x) => x), [k.mean - w, k.mean + w]));
  }
  const sl = c.ready.sleep;
  const lastSleep = c.byDay.get(c.day);
  if (lastSleep && lastSleep.sleep !== null) {
    mt.append(sparkCard("Asleep", "sleep", fmtHm(lastSleep.sleep), "h", sl ? "Need " + fmtHm(sl.need) : "", last14("sleep", (x) => x), null));
  }
  const wb = SB.weeklyBand(c.R, c.day);
  let l7 = 0; for (let z = c.day - 6; z <= c.day; z++) l7 += c.loads.get(z) || 0;
  const l7s = []; for (let z = c.day - 13; z <= c.day; z++) { let t = 0; for (let q = z - 6; q <= z; q++) t += c.loads.get(q) || 0; l7s.push(t); }
  mt.append(sparkCard("Load, last 7 days", "load", String(Math.round(l7)), "", wb.mean ? "Usual " + Math.round(wb.lo) + " to " + Math.round(wb.hi) : "Building your usual", l7s, wb.mean ? [wb.lo, wb.hi] : null));
  const lastWrap = clear($("today-last"));
  const lm = metaList()[0];
  if (lm) lastWrap.append(actCard(lm));
  // suggestion and insights
  $("suggest-intent").textContent = sug.intent + " / " + (SPORT_NAME[sug.sport] || "Any sport");
  $("suggest-session").textContent = sug.session;
  $("suggest-reason").textContent = sug.reason;
  const ins = SB.insights(c.R, c.ready, c.series, c.day, c.daily);
  const il = clear($("insights-list"));
  for (const x of ins) {
    const nums = Object.entries(x.numbers).map(([k, v]) => k + " " + (typeof v === "number" ? (+v.toFixed(2)).toString() : String(v))).join(", ");
    il.append(el("li", null, [el("span", { cls: "grow" }, [x.text, el("span", { cls: "nums", text: "Used: " + nums })])]));
  }
  if (!ins.length) il.append(el("li", null, [el("span", { cls: "grow muted", text: "Notes appear once there is a week of data." })]));
  renderGoals($("goals-today"), c);
  if (typeof renderCoach === "function") renderCoach($("today-coach"));
  // tonight
  const need = sl ? sl.need : s.sleep_base;
  const plan = SB.sleepPlan(need, s.wake_min, s.sleep_latency);
  $("plan-text").textContent = `For a ${fmtHm(need)} need and a ${plan.wake} wake-up, aim to be in bed by ${plan.bedtime}.`;
  // day so far
  const d = c.byDay.get(c.day) || {};
  const dt = APP.kv.hr.length ? SB.dayTrimp(APP.kv.hr, c.day, s) : null;
  stats($("day-stats"), [
    ["Steps", d.steps !== null && d.steps !== undefined ? Math.round(d.steps).toLocaleString("en-US") : "-", ""],
    ["Active energy", d.active_kcal !== null && d.active_kcal !== undefined ? String(Math.round(d.active_kcal)) : "-", "kcal"],
    ["Activities", String(c.R.filter((r) => r.day === c.day).length), ""],
    ["Day load index", dt ? dt.index.toFixed(1) : "-", "of 10"],
  ]);
  const rb = c.ready.rhr ? c.ready.rhr.mean : s.rest_hr;
  const st = APP.kv.hr.length ? SB.stress(APP.kv.hr, c.day, rb, s.max_hr, busyIntervals(c.day)) : [];
  const sc = $("stress-chart");
  if (st.length) {
    const xs = Array.from({ length: 24 }, (_, h) => h), ys = xs.map((h) => { const f = st.find((q) => q.hour === h); return f ? f.level + 0.15 : null; });
    chart(sc, { x: xs, bars: [{ y: ys }], ymin: 0, ymax: 3.2, short: true, xfmt: (v) => String(v).padStart(2, "0") + ":00", yfmt: (v) => String(Math.round(v)) });
  } else { clear(sc); sc.className = ""; sc.append(el("p", { cls: "empty-note", text: "Daytime stress needs all-day heart rate from an Apple Health export." })); }
}
function fmtHm(h) { if (h === null || h === undefined) return "-"; const m = Math.round(h * 60); return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0"); }
function busyIntervals(day) {
  const out = [];
  for (const m of APP.meta.values()) if (Math.abs(m.day - day) <= 1 && m.an) out.push([m.start, m.start + (m.an.elapsed || 0)]);
  return out;
}
function renderGoals(node, c) {
  clear(node);
  if (!APP.kv.goals.length) { node.append(el("p", { cls: "muted", text: "No goals yet. Add weekly, monthly or yearly targets in Log, Gear and goals." })); return; }
  for (const g of APP.kv.goals) {
    const p = SB.goalProgress(c.R, g, c.day);
    const U = UNIT();
    const unitV = g.metric === "distance" ? [p.value / U.len, " " + U.name, +(g.target / U.len).toFixed(1)] : g.metric === "time" ? [p.value / 3600, " h", g.target / 3600]
      : g.metric === "elevation" ? [p.value * U.smallK, " " + U.small, Math.round(g.target * U.smallK)] : [p.value, "", g.target];
    const frac = Math.min(1, unitV[0] / (unitV[2] || 1));
    const bar = el("div", { cls: "bar" }, [el("i")]); bar.firstChild.style.width = (frac * 100).toFixed(1) + "%";
    node.append(el("div", { cls: "goal" }, [
      el("div", { cls: "t" }, [el("span", { text: (g.period === "week" ? "This week" : g.period === "month" ? "This month" : "This year") + ", " + (SPORT_NAME[g.sport] || "all sports").toLowerCase() + " " + (g.metric === "sessions" ? "sessions" : g.metric) }),
        el("span", null, [numEl(unitV[0].toFixed(g.metric === "sessions" || g.metric === "elevation" ? 0 : 1), unitV[1] + " of " + unitV[2])])]),
      bar,
      el("p", { cls: "muted small", text: (unitV[0] / (unitV[2] || 1) >= p.elapsed ? "On pace" : "Behind pace") + ", " + p.days_left + " days left" }),
    ]));
  }
}
