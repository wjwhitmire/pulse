// ---------------------------------------------------------------- Trends
function renderTrends() {
  const c = context(), s = c.s, ser = c.series, n = ser.day.length;
  const last = (a) => (a.length ? a[a.length - 1] : 0);
  stats($("load-stats"), [
    ["Long-term load", last(ser.fitness).toFixed(0), "", true],
    ["Short-term load", last(ser.fatigue).toFixed(0), ""],
    ["Form", last(ser.form).toFixed(0), ""],
    ["Today's load", (c.loads.get(c.day) || 0).toFixed(0), ""],
  ]);
  const from = Math.max(0, n - 120);
  const xs = ser.day.slice(from);
  chart($("load-chart"), { x: xs, tall: true,
    series: [{ y: ser.fitness.slice(from), cls: "s-1", area: true }, { y: ser.fatigue.slice(from), cls: "s-4" }, { y: ser.load.slice(from).map((v) => (v > 0 ? v : null)), dots: true }],
    overlays: cycleOverlays(), xfmt: fmtDayShort, yfmt: (v) => String(Math.round(v)) });
  $("load-note").textContent = `Daily load is the sum of each day's activity loads (${s.load_method === "edwards" ? "zone-weighted" : s.load_method === "lucia" ? "threshold-weighted" : "Banister"} heart rate load; effort x minutes without heart rate). Long-term load is an exponentially weighted average with a ${s.fit_tau}-day time constant, short-term ${s.fat_tau} days. Form = long-term minus short-term load carried into the day.`;
  // weekly bars with the usual band
  const weeks = SB.periods(c.R, "week", c.day, 16);
  const bands = weeks.map((w) => { const b = SB.weeklyBand(c.R, w.start); return b.mean ? [b.lo, b.hi] : [null, null]; });
  chart($("week-bars"), { x: weeks.map((w) => w.start), bars: [{ y: weeks.map((w) => w.load), cur: weeks.length - 1 }], band: { lo: bands.map((b) => b[0]), hi: bands.map((b) => b[1]) },
    xfmt: fmtDayShort, yfmt: (v) => String(Math.round(v)) });
  const ratio = last(ser.ratio);
  $("ratio-text").textContent = ratio !== null && ratio !== undefined
    ? `This week against your usual: ${ratio.toFixed(2)} (mean daily load of the last 7 days over the 21 days before them). Descriptive only. Ratios like this have been promoted as injury predictors; the evidence does not support that use (Impellizzeri et al. 2020), and the classic version shares days between top and bottom (Windt and Gabbett 2019), which is why this one does not.`
    : "This week against your usual appears after four weeks of data.";
  table($("weeks-table"), ["Week of", "Sessions", "Distance", "Time", "Load"], weeks.slice().reverse().slice(0, 10).map((w) => [fmtDayShort(w.start), String(w.count), fmtDist(w.distance, 0), fmtDur(w.moving), w.load.toFixed(0)]), { cls: ["", "r", "r", "r", "r"] });
  const months = SB.periods(c.R, "month", c.day, 6);
  table($("months-table"), ["Month", "Sessions", "Distance", "Time", "Climb", "Energy"], months.slice().reverse().map((m) => { const [y, mo] = SB.civilFromDays(m.start); return [MONTHS[mo - 1] + " " + y, String(m.count), fmtDist(m.distance, 0), fmtDur(m.moving), fmtElev(m.elevation), Math.round(m.kcal) + " kcal"]; }), { cls: ["", "r", "r", "r", "r", "r"] });
  // fitness estimates
  const rhr = c.ready.rhr ? c.ready.rhr.mean : s.rest_hr;
  const uth = SB.vo2maxUth(s.max_hr, rhr);
  const efforts = [];
  for (const m of APP.meta.values()) if (m.sport === "run" && m.day > c.day - 120) for (const f of m.row.fastest) if (f[1] !== null) efforts.push(f);
  const bv = SB.bestVdot(efforts);
  const best = Math.max(uth || 0, bv ? bv.vdot : 0) || null;
  const fage = SB.fitnessAge(best, s.trimp_sex);
  stats($("fit-stats"), [["VO2max from heart rate", uth ? uth.toFixed(1) : "-", "ml/kg/min"], ["VDOT from runs", bv ? bv.vdot.toFixed(1) : "-", ""], ["Fitness age", fage ? fage.toFixed(0) : "-", "years"], ["Your age", String(s.age), "years"]]);
  table($("pred-table"), ["Race", "Predicted time", "Pace"], bv ? bv.predictions.map((p) => [p.label, fmtDur(p.time), fmtPace(p.distance / p.time)]) : [], { empty: "Race predictions need a run of a mile or longer in the last 120 days.", cls: ["txt", "r", "r"] });
  // best power and fastest distances
  const mm = {};
  for (const m of APP.meta.values()) { const p = m.an && m.an.power; if (!p) continue; for (const k of Object.keys(p.meanmax)) if (!mm[k] || p.meanmax[k] > mm[k][0]) mm[k] = [p.meanmax[k], m]; }
  const lab = { 5: "5 s", 30: "30 s", 60: "1 min", 300: "5 min", 1200: "20 min", 3600: "60 min" };
  table($("mmp-table"), ["Duration", "Best", "When"], Object.keys(mm).sort((a, b) => a - b).map((k) => [lab[k] || k + " s", mm[k][0].toFixed(0) + " W", fmtDay(mm[k][1].day)]), { empty: "No power data yet.", cls: ["txt", "r", "r"] });
  const pb = {};
  for (const m of APP.meta.values()) { if (m.sport !== "run" || !m.an || !m.an.fastest) continue; for (const f of m.an.fastest) if (f.time !== null && (!pb[f.label] || f.time < pb[f.label][0])) pb[f.label] = [f.time, m, f.distance]; }
  table($("pb-table"), ["Distance", "Time", "Pace", "When"], SB.TARGETS.filter(([l]) => pb[l]).map(([l]) => [l, fmtDur(pb[l][0]), fmtPace(pb[l][2] / pb[l][0]), fmtDay(pb[l][1].day)]), { empty: "No runs yet.", cls: ["txt", "r", "r", "r"] });
  // year in review
  const years = Array.from(new Set(c.R.map((r) => SB.civilFromDays(r.day)[0]))).sort((a, b) => b - a);
  const ys = $("yr-select"), cur = ys.value;
  clear(ys); years.forEach((y) => ys.append(el("option", { value: String(y), text: String(y) })));
  if (years.includes(+cur)) ys.value = cur;
  const yr = years.length ? SB.yearReview(c.R, +ys.value) : null;
  if (yr) {
    const lm = APP.meta.get(yr.longest), cm = APP.meta.get(yr.biggest_climb);
    stats($("yr-stats"), [["Sessions", String(yr.totals.count), ""], ["Distance", (yr.totals.distance / UNIT().len).toFixed(0), UNIT().name], ["Time", (yr.totals.moving / 3600).toFixed(0), "h"], ["Active days", String(yr.active_days), ""],
      ["Longest streak", String(yr.streak), "days"], ["Top month", yr.top_month ? MONTHS[yr.top_month - 1] : "-", ""], ["Longest", lm ? (lm.row.distance / UNIT().len).toFixed(1) : "-", UNIT().name], ["Biggest climb", cm ? String(Math.round(cm.row.gain * UNIT().smallK)) : "-", UNIT().small]]);
    chart($("yr-months"), { x: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], bars: [{ y: yr.months.map((v) => v / UNIT().len) }], xfmt: (v) => MONTHS[Math.round(v) - 1] || "", yfmt: (v) => String(Math.round(v)), xticks: [1, 3, 5, 7, 9, 11] });
  } else { clear($("yr-stats")); clear($("yr-months")); }
  drawHeatmap($("heatmap"));
  renderDetect(c);
}
function drawHeatmap(canvas) {
  const W = canvas.width, H = canvas.height, ctx2 = canvas.getContext("2d");
  ctx2.fillStyle = tokenColor("--map-land"); ctx2.fillRect(0, 0, W, H);
  const tracks = Array.from(APP.meta.values()).filter((m) => m.thumb && m.thumb.length > 1);
  if (!tracks.length) { ctx2.fillStyle = tokenColor("--muted"); ctx2.font = "28px sans-serif"; ctx2.fillText("No GPS tracks yet.", 32, 60); return; }
  // centre on the median start so one far-away trip does not shrink everything else
  const la = tracks.map((m) => m.thumb[0][0]).sort((a, b) => a - b), lo = tracks.map((m) => m.thumb[0][1]).sort((a, b) => a - b);
  const lat0 = la[la.length >> 1], lon0 = lo[lo.length >> 1];
  const near = tracks.filter((m) => SB.haversine(m.thumb[0][0], m.thumb[0][1], lat0, lon0) < 60000);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  // flat typed arrays [x0, y0, x1, y1, ...] per track: millions of points without millions of objects
  const kk = Math.PI / 180 * 6371008.8, kx = kk * Math.cos(lat0 * Math.PI / 180);
  const proj = near.map((m) => {
    const th = m.thumb, f = new Float64Array(th.length * 2);
    for (let i = 0; i < th.length; i++) {
      const x = (th[i][1] - lon0) * kx, y = (th[i][0] - lat0) * kk;
      f[2 * i] = x; f[2 * i + 1] = y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return f;
  });
  const k = Math.min((W - 40) / Math.max(x1 - x0, 1), (H - 40) / Math.max(y1 - y0, 1)), ox = W / 2 - (x0 + x1) / 2 * k, oy = H / 2 + (y0 + y1) / 2 * k;
  // Rasterise every track straight into a count image, each track once per pixel: far faster than
  // compositing one canvas stroke per track, and counts do not stop at 255.
  const counts = new Uint32Array(W * H), seen = new Int32Array(W * H).fill(-1);
  // pen of about 1.5 screen pixels whatever the canvas is scaled to (2 px on a wide screen, 5 on a phone)
  const pen = Math.max(2, Math.min(6, Math.round(1.5 * W / (canvas.clientWidth || W))));
  const plot = (px, py, id) => {
    for (let dy = 0; dy < pen; dy++) for (let dx = 0; dx < pen; dx++) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (seen[i] !== id) { seen[i] = id; counts[i]++; }
    }
  };
  proj.forEach((t, id) => {
    let qx = null, qy = null;
    for (let i = 0; i < t.length; i += 2) {
      const px = ox + t[i] * k, py = oy - t[i + 1] * k;
      if (qx !== null) {
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(px - qx), Math.abs(py - qy))));
        for (let st = 1; st <= steps; st++) plot(Math.floor(qx + (px - qx) * st / steps), Math.floor(qy + (py - qy) * st / steps), id);
      } else plot(Math.floor(px), Math.floor(py), id);
      qx = px; qy = py;
    }
  });
  const eq = SB.equalize(counts);
  const parse = (hex) => { const h = hex.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; };
  const a = parse(tokenColor("--chart-3")), b = parse(tokenColor("--route")), cc = parse(tokenColor("--z5"));
  const outImg = ctx2.getImageData(0, 0, W, H);
  for (let i = 0; i < W * H; i++) {
    const v = eq[i];
    if (!v) continue;
    const [p, q, f] = v < 0.6 ? [a, b, v / 0.6] : [b, cc, (v - 0.6) / 0.4];
    outImg.data[i * 4] = p[0] + (q[0] - p[0]) * f; outImg.data[i * 4 + 1] = p[1] + (q[1] - p[1]) * f; outImg.data[i * 4 + 2] = p[2] + (q[2] - p[2]) * f; outImg.data[i * 4 + 3] = 255;
  }
  ctx2.putImageData(outImg, 0, 0);
}
function renderDetect(c) {
  const s = c.s, hr = APP.kv.hr;
  if (!hr.length) { table($("detect-table"), ["Start"], [], { empty: "Needs all-day heart rate from an Apple Health export." }); return; }
  const busy = [];
  for (const m of APP.meta.values()) if (m.an) busy.push([m.start, m.start + (m.an.elapsed || 0)]);
  const rest = c.ready.rhr ? c.ready.rhr.mean : s.rest_hr;
  const found = SB.detectWorkouts(hr.filter((x) => x[0] * 60 > (c.day - 14) * 86400), rest, s.max_hr, busy).slice(-20).reverse();
  table($("detect-table"), ["Start", "Minutes", "Avg HR", ""], found.map((w) => {
    const add = el("button", { type: "button", cls: "btn", text: "Add as activity" });
    add.addEventListener("click", () => addDetected(w));
    return [fmtDay(localDay(w.start)) + " " + fmtClockTs(w.start), String(w.minutes), w.avg_hr.toFixed(0), add];
  }), { empty: "Nothing found in the last 14 days.", cls: ["", "r", "r", ""] });
}
async function addDetected(w) {
  const act = SB.newActivity("detected", "Detected workout", "other");
  for (const [m, v] of APP.kv.hr) if (m * 60 >= w.start && m * 60 < w.end) { act.t.push(m * 60); act.lat.push(null); act.lon.push(null); act.ele.push(null); act.hr.push(v); act.cad.push(null); act.pwr.push(null); act.dist.push(null); }
  if (act.t.length < 2) return;
  act.start = act.t[0];
  await saveActivity(act, null, null);
  invalidate(); setStatus(APP.example ? "Added to the example on screen. Example data is not saved; with your own Health export, detected workouts are kept." : "Added the detected workout to your log."); route();
}
