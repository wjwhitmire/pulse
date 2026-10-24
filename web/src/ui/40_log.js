// ---------------------------------------------------------------- Log: calendar and list
let LOG_SHOWN = 40;
function tokenColor(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888"; }
function filteredMeta() {
  const sp = $("act-sport").value;
  return metaList().filter((m) => sp === "all" || m.sport === sp);
}
// File formats keep their capitals; services keep their own spelling; the example says so plainly.
const SOURCE_NAME = { example: "the example data", fit: "a FIT file", gpx: "a GPX file", tcx: "a TCX file", strava: "a Strava export", whoop: "a Whoop export",
  apple: "Apple Health", detected: "all-day heart rate", recorded: "a recording", plan: "a planned route", summary: "a summary" };
const PHONE = window.matchMedia ? window.matchMedia("(max-width: 639px)") : null;
// On a phone the 12-week grid's day cells would be about 30 px wide, under the 44 px touch size, so
// the calendar becomes an agenda: each week with its total, then one full-width row per activity.
function renderAgenda(node, metric, c) {
  node.className = "agenda";
  const ms = filteredMeta(), ws = SB.weekStart(c.day);
  const total = (list) => { let t = 0; for (const m of list) t += metric === "distance" ? m.row.distance : metric === "elevation" ? m.row.gain : metric === "load" ? (m.row.load || 0) : m.row.moving; return t; };
  const fmt = (t) => (metric === "distance" ? (t / UNIT().len).toFixed(1) + " " + UNIT().name : metric === "elevation" ? fmtElev(t) : metric === "load" ? String(Math.round(t)) : fmtDur(t));
  let shown = 0;
  for (let w = 0; w < 12; w++) {
    const a = ws - 7 * w, list = ms.filter((m) => m.day >= a && m.day < a + 7).sort((x, y) => y.start - x.start);
    if (!list.length) continue;
    shown++;
    node.append(el("p", { cls: "ag-week" }, [el("span", { text: "Week of " + fmtDayShort(a) }), el("span", { cls: "num", text: fmt(total(list)) })]));
    for (const m of list) {
      const b = el("button", { type: "button", cls: "ag-row " + m.sport }, [el("i", { cls: "dot " + m.sport }), el("span", { cls: "grow", text: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(m.day + 3) % 7] + " " + fmtDayShort(m.day) + ", " + m.name }), el("span", { cls: "num", text: fmt(total([m])) })]);
      b.addEventListener("click", () => { APP.scrollToDetail = true; location.hash = "#log/" + m.id; });
      node.append(b);
    }
  }
  if (!shown) node.append(el("p", { cls: "muted", text: "No activities in the last 12 weeks." }));
}
function renderCalendar() {
  const node = clear($("calendar")), metric = $("cal-metric").value, c = context();
  if (PHONE && PHONE.matches) { renderAgenda(node, metric, c); return; }
  node.className = "calendar";
  node.append(el("span", { cls: "h", text: "Week" }));
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((d) => node.append(el("span", { cls: "h", text: d })));
  node.append(el("span", { cls: "h", text: "Total" }));
  const ms = filteredMeta(), byDay = new Map();
  for (const m of ms) { if (!byDay.has(m.day)) byDay.set(m.day, []); byDay.get(m.day).push(m); }
  const val = (m) => { const r = m.row; return metric === "distance" ? r.distance / 1000 : metric === "elevation" ? r.gain / 50 : metric === "load" ? (r.load || 0) / 20 : r.moving / 1200; };
  let maxV = 1;
  for (const m of ms) maxV = Math.max(maxV, val(m));
  const ws = SB.weekStart(c.day);
  for (let w = 11; w >= 0; w--) {
    const a = ws - 7 * w;
    node.append(el("span", { cls: "wk", text: fmtDayShort(a) }));
    let tot = 0;
    for (let k = 0; k < 7; k++) {
      const cell = el("span", { cls: "d" });
      for (const m of byDay.get(a + k) || []) {
        const v = val(m), size = Math.round(8 + 18 * Math.sqrt(v / maxV));
        const b = el("button", { type: "button", cls: "dot " + m.sport, "aria-label": m.name + ", " + fmtDay(m.day), title: m.name });
        b.style.width = size + "px"; b.style.height = size + "px";
        b.addEventListener("click", () => { location.hash = "#log/" + m.id; });
        cell.append(b);
        tot += metric === "distance" ? m.row.distance : metric === "elevation" ? m.row.gain : metric === "load" ? (m.row.load || 0) : m.row.moving;
      }
      node.append(cell);
    }
    node.append(el("span", { cls: "tot", text: metric === "distance" ? (tot / UNIT().len).toFixed(0) + " " + UNIT().name : metric === "elevation" ? fmtElev(tot) : metric === "load" ? String(Math.round(tot)) : fmtDur(tot) }));
  }
}
function renderActList() {
  const ul = clear($("act-list")), ms = filteredMeta();
  $("act-count").textContent = ms.length + " activities";
  for (const m of ms.slice(0, LOG_SHOWN)) {
    const r = m.row;
    const li = el("li", { tabindex: "0", role: "button", "aria-selected": APP.selected === m.id ? "true" : "false" }, [
      el("span", { cls: "ic" }, [icon(m.sport === "ride" ? "ride" : m.sport === "run" ? "run" : m.sport === "strength" ? "strength" : "time")]),
      el("span", { cls: "grow" }, [el("span", { text: m.name }), el("span", { cls: "sub", text: fmtDay(m.day) + " / " + (r.distance ? fmtDist(r.distance, 1) + " / " : "") + fmtDur(r.moving) })]),
      numEl(r.load === null || r.load === undefined ? "-" : String(Math.round(r.load))),
    ]);
    const go = () => { APP.scrollToDetail = true; location.hash = "#log/" + m.id; };
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    ul.append(li);
  }
  if (!ms.length) ul.append(el("li", null, [el("span", { cls: "grow muted", text: "No activities yet. Import files in Settings, or record one." })]));
  $("act-more").hidden = ms.length <= LOG_SHOWN;
}

// ---------------------------------------------------------------- activity detail
function bucket(xs, ys, maxN) {
  const n = xs.length;
  if (n <= maxN) return [xs, ys];
  const k = Math.ceil(n / maxN), ox = [], oy = [];
  for (let i = 0; i < n; i += k) {
    let sx = 0, sy = 0, cy = 0;
    for (let j = i; j < Math.min(n, i + k); j++) { sx += xs[j]; if (ys[j] !== null && ys[j] !== undefined) { sy += ys[j]; cy++; } }
    ox.push(sx / Math.min(k, n - i)); oy.push(cy ? sy / cy : null);
  }
  return [ox, oy];
}
function drawRoute(canvas, act, an, highlight) {
  const ctx2 = canvas.getContext("2d"), W = canvas.width, H = canvas.height;
  ctx2.fillStyle = tokenColor("--map-land"); ctx2.fillRect(0, 0, W, H);
  const idx = [];
  for (let i = 0; i < act.t.length; i++) if (act.lat[i] !== null) idx.push(i);
  if (idx.length < 2) { ctx2.fillStyle = tokenColor("--muted"); ctx2.font = "28px sans-serif"; ctx2.fillText("No GPS track in this activity.", 32, 60); return; }
  const lat0 = act.lat[idx[0]], lon0 = act.lon[idx[0]];
  const xy = idx.map((i) => SB.projectLocal(act.lat[i], act.lon[i], lat0, lon0));
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of xy) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const k = Math.min((W - 80) / Math.max(x1 - x0, 1), (H - 80) / Math.max(y1 - y0, 1));
  const ox = W / 2 - (x0 + x1) / 2 * k, oy = H / 2 + (y0 + y1) / 2 * k;
  const P = (p) => [ox + p[0] * k, oy - p[1] * k];
  ctx2.lineCap = "round"; ctx2.lineJoin = "round";
  ctx2.strokeStyle = tokenColor("--surface"); ctx2.lineWidth = 12; ctx2.globalAlpha = 0.85;
  ctx2.beginPath(); xy.forEach((p, j) => { const [x, y] = P(p); if (j) ctx2.lineTo(x, y); else ctx2.moveTo(x, y); }); ctx2.stroke();
  ctx2.globalAlpha = 1; ctx2.lineWidth = 6;
  const bounds = an && an.hr ? an.hr.bounds : null, zc = [1, 2, 3, 4, 5].map((z) => tokenColor("--z" + z)), route = tokenColor("--route");
  for (let j = 1; j < xy.length; j++) {
    const h = act.hr[idx[j - 1]];
    let col = route;
    if (bounds && h !== null) { let z = 0; for (const b of bounds) if (h >= b) z++; col = zc[Math.max(0, Math.min(4, z - 1))]; }
    ctx2.strokeStyle = col;
    const [ax, ay] = P(xy[j - 1]), [bx, by] = P(xy[j]);
    ctx2.beginPath(); ctx2.moveTo(ax, ay); ctx2.lineTo(bx, by); ctx2.stroke();
  }
  if (highlight) {
    const [a, b] = highlight;
    ctx2.strokeStyle = tokenColor("--fg"); ctx2.lineWidth = 3; ctx2.setLineDash([10, 8]);
    ctx2.beginPath();
    let started = false;
    idx.forEach((i, j) => { if (i < a || i > b) return; const [x, y] = P(xy[j]); if (started) ctx2.lineTo(x, y); else { ctx2.moveTo(x, y); started = true; } });
    ctx2.stroke(); ctx2.setLineDash([]);
  }
  const dot = (p, fill) => { const [x, y] = P(p); ctx2.beginPath(); ctx2.arc(x, y, 9, 0, 2 * Math.PI); ctx2.fillStyle = fill; ctx2.fill(); ctx2.lineWidth = 3; ctx2.strokeStyle = tokenColor("--surface"); ctx2.stroke(); };
  dot(xy[0], tokenColor("--accent")); dot(xy[xy.length - 1], tokenColor("--fg"));
  // scale bar
  const mpp = 1 / k, target = mpp * 160, nice = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].find((v) => v >= target) || 50000;
  ctx2.strokeStyle = tokenColor("--muted"); ctx2.lineWidth = 2; ctx2.beginPath(); ctx2.moveTo(24, H - 24); ctx2.lineTo(24 + nice * k, H - 24); ctx2.stroke();
  ctx2.fillStyle = tokenColor("--muted"); ctx2.font = "20px sans-serif"; ctx2.fillText(nice >= 1000 ? nice / 1000 + " km" : nice + " m", 24, H - 32);
}
async function openActivity(id) {
  const m = APP.meta.get(id);
  if (!m) { $("act-detail").hidden = true; return; }
  APP.selected = id;
  renderActList();
  $("act-detail").hidden = false;
  const act = m.summary_only ? null : await getStreams(id);
  const s = APP.settings;
  const an = act ? SB.analyze(act, s, m.rpe) : (m.an || {});
  const sport = m.sport, r = m.row;
  clear($("ad-sport")).append(icon(sport === "ride" ? "ride" : sport === "run" ? "run" : sport === "strength" ? "strength" : "time"));
  $("ad-title").textContent = m.name;
  $("ad-meta").textContent = fmtDay(m.day) + ", " + fmtClockTs(m.start) + ". " + (SPORT_NAME[sport] || "Activity") + (m.source ? ", from " + (SOURCE_NAME[m.source] || m.source) : "") + (m.summary_only ? ". Summary only: no samples." : ".");
  stats($("ad-stats"), [
    ["Distance", r.distance ? (r.distance / UNIT().len).toFixed(2) : "-", UNIT().name],
    ["Moving time", fmtDur(r.moving), ""],
    [sport === "run" ? "Avg pace" : "Avg speed", sport === "run" ? fmtDur(an.speed ? UNIT().len / an.speed : null) : (an.speed ? (an.speed * 3600 / UNIT().len).toFixed(1) : "-"), sport === "run" ? "/" + UNIT().name : UNIT().name + "/h"],
    ["Elevation", r.gain ? String(Math.round(r.gain * UNIT().smallK)) : "-", UNIT().small],
    ["Avg HR", an.hr ? an.hr.avg.toFixed(0) : (an.avg_hr ? String(Math.round(an.avg_hr)) : "-"), "bpm"],
    ["Training load", r.load === null || r.load === undefined ? "-" : String(Math.round(r.load)), "", true],
  ]);
  $("ad-name").value = m.name;
  const gs = clear($("ad-gear"));
  gs.append(el("option", { value: "", text: "None" }));
  for (const g of APP.kv.gear) gs.append(el("option", { value: g.id, text: g.name }));
  gs.value = m.gear || "";
  const rpe = clear($("ad-rpe"));
  for (let k = 1; k <= 10; k++) {
    const b = el("button", { type: "button", "aria-pressed": m.rpe === k ? "true" : "false", text: String(k) });
    b.addEventListener("click", () => { for (const x of rpe.children) x.setAttribute("aria-pressed", "false"); b.setAttribute("aria-pressed", "true"); rpe.dataset.v = String(k); });
    rpe.append(b);
  }
  rpe.dataset.v = m.rpe ? String(m.rpe) : "";
  $("ad-confirm").hidden = true;
  const canvas = $("ad-route");
  const hasTrack = act && act.lat.some((x) => x !== null);
  $("ad-map").hidden = !hasTrack;
  ["ad-power-card", "ad-cad-card", "ad-laps-card"].forEach((x) => { $(x).hidden = false; });
  if (!act) {
    for (const x of ["ad-ele", "ad-hr", "ad-pace", "ad-power", "ad-cad"]) { clear($(x)).className = ""; $(x).append(el("p", { cls: "empty-note", text: "No samples in a summary-only activity." })); }
    clear($("ad-zones")); clear($("ad-elev"));
    table($("ad-splits"), ["Split"], []); table($("ad-laps"), ["Lap"], []); table($("ad-fast"), ["Distance"], []); table($("ad-repeat"), ["Date"], []); table($("ad-segs"), ["Segment"], []);
    $("ad-power-card").hidden = true; $("ad-cad-card").hidden = true;
    return;
  }
  drawRoute(canvas, act, an);
  const d = an._d, useDist = d[d.length - 1] > 100;
  const X = useDist ? d.map((v) => v / UNIT().len) : act.t.map((v) => (v - act.t[0]) / 60);
  const xfmt = useDist ? (v) => v.toFixed(v < 10 ? 1 : 0) : (v) => fmtDur(v * 60);
  const overlays = cycleOverlays(null);
  // elevation
  const [ex, eyRaw] = bucket(X, act.ele, 600);
  const [, eyS] = an._ez ? bucket(X, an._ez, 600) : [null, null];
  chart($("ad-ele"), { x: ex, series: [{ y: eyRaw.map((v) => (v === null ? null : v * UNIT().smallK)), cls: "s-raw" }].concat(eyS ? [{ y: eyS.map((v) => v * UNIT().smallK), cls: "s-1", area: true }] : []), xfmt, yfmt: (v) => String(Math.round(v)), empty: "No elevation in this file." });
  const el_ = an.elevation;
  let elevTxt = el_ ? `Recorded: ${fmtElev(el_.raw_gain)} of climbing summed from every rise. Corrected: ${fmtElev(el_.gain)} after a ${s.ele_window}-sample moving average and ignoring reversals under ${s.ele_hyst} m.` : "No elevation in this file.";
  if (APP.dem && el_) {
    const corr = SB.correctElevation(APP.dem, act);
    const e2 = SB.elevation(corr, s);
    if (e2) elevTxt += ` With your elevation file: ${fmtElev(e2.gain)}.`;
  }
  $("ad-elev").textContent = elevTxt;
  // heart rate with zone bands
  const [hx, hy] = bucket(X, act.hr, 600);
  const b = SB.zoneBounds(s), zones = [[b[0], b[1], 1], [b[1], b[2], 2], [b[2], b[3], 3], [b[3], b[4], 4], [b[4], s.max_hr + 20, 5]];
  chart($("ad-hr"), { x: hx, series: [{ y: hy, cls: "s-hr" }], zones, xfmt, yfmt: (v) => String(Math.round(v)), empty: "No heart rate in this file." });
  // pace or speed (30 s smoothing on segment speeds)
  const sp = [];
  for (let i = 0; i < act.t.length; i++) {
    let j = i; while (j > 0 && act.t[i] - act.t[j] < 30) j--;
    const dt = act.t[i] - act.t[j], dd = d[i] - d[j];
    sp.push(dt > 0 && an._mov[i] ? dd / dt : null);
  }
  const [px, py] = bucket(X, sp, 600);
  $("ad-pace-h").textContent = sport === "run" ? "Pace" : "Speed";
  if (sport === "run") chart($("ad-pace"), { x: px, series: [{ y: py.map((v) => (v && v > 0.8 ? UNIT().len / v / 60 : null)), cls: "s-1" }], xfmt, yfmt: (v) => fmtDur(v * 60) });
  else chart($("ad-pace"), { x: px, series: [{ y: py.map((v) => (v ? v * 3600 / UNIT().len : null)), cls: "s-1" }], xfmt, yfmt: (v) => String(Math.round(v)) });
  const pw = an.power;
  $("ad-power-card").hidden = !pw;
  if (pw) {
    const [wx, wy] = bucket(X, act.pwr, 600);
    chart($("ad-power"), { x: wx, series: [{ y: wy, cls: "s-1" }], xfmt, yfmt: (v) => String(Math.round(v)) });
    stats($("ad-power-stats"), [["Average", pw.avg.toFixed(0), "W"], ["Weighted (30 s, 4th power)", pw.weighted ? pw.weighted.toFixed(0) : "-", "W"], ["Max", pw.max.toFixed(0), "W"],
      ["Best 5 min", pw.meanmax["300"] ? pw.meanmax["300"].toFixed(0) : "-", "W"], ["Power load", an.power_load ? an.power_load.toFixed(0) : "-", ""], ["Variability", pw.weighted ? (pw.weighted / pw.avg).toFixed(2) : "-", ""]]);
  }
  const hasCad = act.cad.some((v) => v);
  $("ad-cad-card").hidden = !hasCad;
  if (hasCad) { const [cx, cy] = bucket(X, act.cad.map((v) => (v ? v : null)), 600); chart($("ad-cad"), { x: cx, series: [{ y: cy, cls: "s-2nd" }], xfmt, yfmt: (v) => String(Math.round(v)) }); }
  // zones
  const zn = clear($("ad-zones"));
  if (an.hr) zoneBar(zn, "Heart rate", an.hr.zones.slice(1), ["Z1", "Z2", "Z3", "Z4", "Z5"]);
  if (an.pace_zones) zoneBar(zn, "Pace (against your threshold pace)", an.pace_zones.slice(1), ["P2", "P3", "P4", "P5", "P6"]);
  if (an.power_zones) zoneBar(zn, "Power (levels 2 to 6 against FTP)", an.power_zones.slice(1, 6), ["L2", "L3", "L4", "L5", "L6"]);
  if (!zn.childNodes.length) zn.append(el("p", { cls: "muted", text: "No heart rate, pace threshold or FTP to place this activity in zones." }));
  const kcal = an.calories ? Math.round(an.calories.kcal) + " kcal (" + (an.calories.method === "keytel" ? "from heart rate, Keytel 2005" : "from METs, Compendium of Physical Activities") + ")" : "";
  zn.append(el("p", { cls: "muted small", text: [kcal, an.gap ? "Grade-adjusted pace " + fmtPace(an.gap.speed) + " (Minetti 2002)." : "", an.max_speed ? "Max speed " + fmtSpeed(an.max_speed) + "." : "", an.hr ? "Banister load " + an.hr.trimp.toFixed(0) + ", zone load " + an.hr.edwards.toFixed(0) + (an.lucia !== null ? ", threshold load " + an.lucia.toFixed(0) : "") + "." : ""].filter(Boolean).join(" ") }));
  // splits
  const fastest = an.splits.length ? an.splits.reduce((bi, sx, i, arr) => (sx.moving / sx.distance < arr[bi].moving / arr[bi].distance ? i : bi), 0) : -1;
  const maxV = Math.max(...an.splits.map((sx) => sx.distance / Math.max(sx.moving, 1)), 0.01);
  table($("ad-splits"), [UNIT().name, sport === "run" ? "Pace" : "Speed", "", "Elev", "HR"], an.splits.map((sx, i) => {
    const v = sx.distance / Math.max(sx.moving, 1), bar = el("span", { cls: "bar" }, [el("i")]);
    bar.firstChild.style.width = (v / maxV * 100).toFixed(0) + "%";
    const pace = el("span", { text: fmtPaceOrSpeed(sport, v) });
    if (i === fastest) pace.append(el("span", { cls: "tag", text: "Fastest" }));
    return [String(sx.distance < UNIT().len * 0.999 ? (sx.distance / UNIT().len).toFixed(2) : sx.index), pace, bar, sx.ele_delta === null ? "-" : (sx.ele_delta >= 0 ? "+" : "") + Math.round(sx.ele_delta * UNIT().smallK), sx.avg_hr ? sx.avg_hr.toFixed(0) : "-"];
  }), { best: fastest, cls: ["", "", "", "r", "r"] });
  $("ad-laps-card").hidden = !an.lap_table || an.lap_table.length < 2;
  table($("ad-laps"), ["Lap", "Distance", "Time", sport === "run" ? "Pace" : "Speed", "HR"], (an.lap_table || []).map((l) => [String(l.index), fmtDist(l.distance), fmtDur(l.elapsed), fmtPaceOrSpeed(sport, l.distance / Math.max(l.elapsed, 1)), l.avg_hr ? l.avg_hr.toFixed(0) : "-"]));
  table($("ad-fast"), ["Distance", "Time", sport === "run" ? "Pace" : "Speed", "Starts at"], an.fastest.filter((f) => f.time !== null).map((f) => [f.label, fmtDur(f.time), fmtPaceOrSpeed(sport, f.distance / f.time), fmtDur(f.start)]), { empty: "Too short for the standard distances." });
  // repeat route
  const sig = SB.signature(act, d), same = [];
  for (const o of APP.meta.values()) if (o.sig && sig && SB.sameRoute(sig, o.sig)) same.push(o);
  same.sort((a2, b2) => b2.start - a2.start);
  table($("ad-repeat"), ["Date", "Time", "Moving", sport === "run" ? "Pace" : "Speed"], same.map((o) => [o.id === id ? "This one" : fmtDay(o.day), fmtDur(o.row.elapsed), fmtDur(o.row.moving), fmtPaceOrSpeed(o.sport, o.row.distance / Math.max(o.row.moving, 1))]),
    { empty: "No other activity follows this route.", onRow: (i) => { location.hash = "#log/" + same[i].id; } });
  // segments
  renderSegmentsFor(m, act);
  const sf = $("seg-from"), st = $("seg-to");
  const hl = () => { const n = act.t.length - 1; drawRoute(canvas, act, an, [Math.round(Math.min(sf.value, st.value) / 100 * n), Math.round(Math.max(sf.value, st.value) / 100 * n)]); };
  sf.oninput = hl; st.oninput = hl;
  APP.detail = { m, act, an };
  if (window.innerWidth < 960 && APP.scrollToDetail) { APP.scrollToDetail = false; $("act-detail").scrollIntoView({ block: "start" }); }
}
function renderSegmentsFor(m, act) {
  const rowsOut = [];
  for (const sg of APP.kv.segments) {
    const mine = SB.matchSegment(sg.seg, act);
    const best = sg.efforts.length ? Math.min(...sg.efforts.map((e) => e.elapsed)) : null;
    rowsOut.push([sg.name, mine.length ? fmtDur(Math.min(...mine.map((e) => e.elapsed))) : "-", best === null ? "-" : fmtDur(best), String(sg.efforts.length)]);
  }
  table($("ad-segs"), ["Segment", "This activity", "Your best", "Efforts"], rowsOut, { empty: "No segments saved yet.", cls: ["txt", "", "", "r"] });
}
async function saveSegment() {
  const D = APP.detail;
  if (!D) return;
  const n = D.act.t.length - 1, a = Math.round(Math.min($("seg-from").value, $("seg-to").value) / 100 * n), b = Math.round(Math.max($("seg-from").value, $("seg-to").value) / 100 * n);
  let seg;
  try { seg = SB.makeSegment(D.act, a, b, $("seg-name").value.slice(0, 80)); } catch (e) { setStatus(e.message); return; }
  const efforts = [];
  setStatus("Finding the segment in your other activities.");
  for (const m of APP.meta.values()) {
    if (!m.thumb || !m.thumb.length || m.summary_only) continue;
    const near = m.thumb.some(([la, lo]) => SB.haversine(la, lo, seg.origin[0], seg.origin[1]) < 3000);
    if (!near) continue;
    const act = await getStreams(m.id);
    if (!act) continue;
    for (const e of SB.matchSegment(seg, act)) efforts.push({ id: m.id, start: e.start, elapsed: e.elapsed });
  }
  APP.kv.segments.push({ id: "s" + Date.now(), name: seg.name || "Segment", seg, efforts });
  await saveKv("segments");
  setStatus(`Saved. Found ${efforts.length} effort${efforts.length === 1 ? "" : "s"} on this segment.`);
  renderSegmentsFor(D.m, D.act);
}
function cycleOverlays(range) {
  if (!APP.kv.cycleOverlay || !APP.kv.cycle.length) return [];
  const out = [];
  for (const st of APP.kv.cycle) out.push([st, st + 5]);
  return out;
}

// ---------------------------------------------------------------- strength
function strengthRow(ex, reps, load) {
  const tr = el("tr", null, [
    el("td", null, [el("input", { type: "text", maxlength: "60", value: ex || "", "aria-label": "Exercise", list: "st-exercises" })]),
    el("td", null, [el("input", { type: "number", min: "1", max: "100", step: "1", value: reps || "", "aria-label": "Reps" })]),
    el("td", null, [el("input", { type: "number", min: "0", max: "1000", step: "0.5", value: load || "", "aria-label": "Load" })]),
  ]);
  return tr;
}
function renderStrengthEditor() {
  const t = clear($("st-sets"));
  t.append(el("thead", null, [el("tr", null, [el("th", { text: "Exercise" }), el("th", { text: "Reps" }), el("th", { text: "Load" })])]));
  const tb = el("tbody");
  for (let k = 0; k < 3; k++) tb.append(strengthRow());
  t.append(tb);
  if (!$("st-exercises")) {
    const dl = el("datalist", { id: "st-exercises" });
    ["Back squat", "Front squat", "Deadlift", "Bench press", "Overhead press", "Pull-up", "Barbell row", "Lunge", "Hip thrust"].forEach((n) => dl.append(el("option", { value: n })));
    document.body.append(dl);
  }
  $("st-date").value = inputFromDay(refDay());
  // Load unit: the one used last time, else pounds with miles and kilograms with kilometres.
  let last = null;
  try { last = localStorage.getItem("pulse.liftUnit"); } catch (e) {}
  $("st-unit").value = last === "kg" || last === "lb" ? last : (APP.settings.units === "mi" ? "lb" : "kg");
}
async function saveStrength() {
  const z = dayFromInput($("st-date").value);
  if (z === null) { setStatus("Pick a date for the session."); return; }
  const k = $("st-unit").value === "lb" ? 0.45359237 : 1;
  const sets = [];
  for (const tr of $("st-sets").querySelectorAll("tbody tr")) {
    const [a, b, c] = tr.querySelectorAll("input");
    const ex = a.value.trim().slice(0, 60), reps = parseInt(b.value, 10), load = parseFloat(c.value);
    if (ex && Number.isFinite(load) && load < 0) { setStatus("A load cannot be negative. Use 0 for bodyweight."); return; }
    if (ex && reps > 0 && reps <= 100) sets.push({ exercise: ex, reps, load: Number.isFinite(load) && load >= 0 ? load * k : 0 });
  }
  if (!sets.length) { setStatus("Add at least one set with an exercise and reps."); return; }
  await ownLog();
  try { localStorage.setItem("pulse.liftUnit", $("st-unit").value); } catch (e) {}
  const ses = { id: "st" + Date.now(), date: z, name: $("st-name").value.slice(0, 80) || "Strength", sets };
  APP.kv.strength.push(ses);
  await saveKv("strength");
  setStatus("Session saved.");
  renderStrengthEditor(); renderStrength();
}
function renderStrength() {
  const recs = SB.strengthRecords(APP.kv.strength);
  const names = Object.keys(recs).sort();
  table($("st-prs"), ["Exercise", "Est. 1RM", "Heaviest", "Best set"], names.map((n) => {
    const r = recs[n];
    return [n, r.e1rm.toFixed(1) + " kg", r.load.toFixed(1) + " kg", r.set_volume.toFixed(0) + " kg"];
  }), { empty: "No sessions yet.", cls: ["txt", "r", "r", "r"] });
  const sel = $("st-ex"), cur = sel.value;
  clear(sel);
  names.forEach((n) => sel.append(el("option", { value: n, text: n })));
  if (names.includes(cur)) sel.value = cur;
  const r = recs[sel.value];
  if (r && r.trend.length >= 2) chart($("st-trend"), { x: r.trend.map((p) => p[0]), series: [{ y: r.trend.map((p) => p[1]), cls: "s-1" }], xfmt: fmtDayShort, yfmt: (v) => String(Math.round(v)) });
  else { const n = clear($("st-trend")); n.className = ""; n.append(el("p", { cls: "empty-note", text: "A trend needs two sessions of the same exercise." })); }
  const list = APP.kv.strength.slice().sort((a, b) => b.date - a.date);
  table($("st-list"), ["Date", "Session", "Sets", "Volume", ""], list.map((ses) => {
    const del = el("button", { type: "button", cls: "btn ghost", text: "Delete", "aria-label": "Delete session" });
    del.addEventListener("click", async () => { APP.kv.strength = APP.kv.strength.filter((x) => x.id !== ses.id); await saveKv("strength"); renderStrength(); });
    return [fmtDay(ses.date), ses.name, String(ses.sets.length), SB.sessionStats(ses).volume.toFixed(0) + " kg", del];
  }), { empty: "No sessions yet.", cls: ["", "txt", "r", "r", ""] });
}

// ---------------------------------------------------------------- journal, goals, gear
async function saveJournal() {
  const z = dayFromInput($("jr-date").value), tag = $("jr-tag").value.trim().slice(0, 120);
  if (z === null || !tag) { setStatus("Pick a day and a question."); return; }
  await ownLog();
  const j = APP.kv.journal;
  if (!j[z]) j[z] = {};
  j[z][tag] = $("jr-yes").value === "1";
  await saveKv("journal");
  setStatus("Answer saved.");
  renderJournal();
}
function renderJournal() {
  const c = context(), tags = new Set();
  for (const z of Object.keys(APP.kv.journal)) for (const t of Object.keys(APP.kv.journal[z])) tags.add(t);
  const dl = clear($("jr-tags"));
  for (const t of tags) dl.append(el("option", { value: t }));
  $("jr-date").value = $("jr-date").value || inputFromDay(c.day);
  const metricKey = c.ready.hrv ? c.ready.hrv.metric : "rmssd";
  const metric = {};
  for (const d of c.daily) if (d[metricKey]) metric[d.date] = Math.log(d[metricKey]);
  const out = Array.from(tags).sort().map((t) => {
    const a = SB.association(APP.kv.journal, metric, c.day, t, 90, 2000, 12345);
    const pct = a.diff === null ? "-" : ((Math.exp(a.diff) - 1) * 100 >= 0 ? "+" : "") + ((Math.exp(a.diff) - 1) * 100).toFixed(0) + "%";
    return [t, a.n_yes + " / " + a.n_no, pct, a.d === null ? "-" : a.d.toFixed(2), a.p === null ? "Needs 5 of each" : a.p.toFixed(3)];
  });
  table($("jr-assoc"), ["Question", "Yes / no days", "HRV next day", "Effect size", "Permutation p"], out, { empty: "No answers yet.", cls: ["txt", "r", "r", "r", "r"] });
}
async function addGoal() {
  const t = parseFloat($("gl-target").value);
  if (!(t > 0)) { setStatus("Enter a target above zero."); return; }
  const metric = $("gl-metric").value;
  await ownLog();
  APP.kv.goals.push({ id: "g" + Date.now(), metric, period: $("gl-period").value, sport: $("gl-sport").value,
    // targets are typed in the units shown (km or mi, m or ft) and stored in metres and seconds
    target: metric === "distance" ? t * UNIT().len : metric === "time" ? t * 3600 : metric === "elevation" ? t / UNIT().smallK : t, shown: t });
  await saveKv("goals");
  renderGoalsTab();
}
function renderGoalsTab() {
  const c = context(), node = clear($("gl-list"));
  const opt = (v) => $("gl-metric").querySelector('option[value="' + v + '"]');
  opt("distance").textContent = "Distance (" + UNIT().name + ")";
  opt("elevation").textContent = "Climb (" + UNIT().small + ")";
  renderGoals(node, c);
  for (const g of APP.kv.goals) {
    const del = el("button", { type: "button", cls: "btn ghost", text: "Remove " + g.period + " " + g.metric + " goal" });
    del.addEventListener("click", async () => { APP.kv.goals = APP.kv.goals.filter((x) => x.id !== g.id); await saveKv("goals"); renderGoalsTab(); });
    node.append(del);
  }
  const gt = SB.gearTotals(APP.kv.gear, c.R);
  table($("gr-table"), ["Gear", "Distance", "Uses", "Status", ""], APP.kv.gear.map((g, i) => {
    const t = gt[i];
    const del = el("button", { type: "button", cls: "btn ghost", text: "Remove" });
    del.addEventListener("click", async () => { APP.kv.gear = APP.kv.gear.filter((x) => x.id !== g.id); await saveKv("gear"); renderGoalsTab(); });
    return [g.name, fmtDist(t.distance, 0), String(t.count), t.retire ? "Time to retire" : t.remaining !== null ? fmtDist(t.remaining, 0) + " left" : "In use", del];
  }), { empty: "No gear yet. Imported Strava gear appears here too.", cls: ["txt", "r", "r", "txt", ""] });
}
async function addGear() {
  const name = $("gr-name").value.trim().slice(0, 80);
  if (!name) { setStatus("Give the gear a name."); return; }
  await ownLog();
  APP.kv.gear.push({ id: "gear" + Date.now(), name, kind: $("gr-kind").value, start_km: Math.max(0, parseFloat($("gr-start").value) || 0), retire_km: Math.max(0, parseFloat($("gr-retire").value) || 0) || null });
  await saveKv("gear");
  $("gr-name").value = "";
  renderGoalsTab();
}
function renderLog(sub, id) {
  const subs = { acts: "log-acts", strength: "log-strength", journal: "log-journal", goals: "log-goals" };
  for (const k of Object.keys(subs)) { $(subs[k]).hidden = k !== sub; $("log-s-" + k).setAttribute("aria-pressed", k === sub ? "true" : "false"); }
  if (sub === "acts") {
    renderCalendar(); renderActList();
    if (id && APP.meta.has(id)) openActivity(id); else if (!id) { $("act-detail").hidden = true; APP.selected = null; }
  } else if (sub === "strength") { if (!$("st-sets").firstChild) renderStrengthEditor(); renderStrength(); }
  else if (sub === "journal") renderJournal();
  else renderGoalsTab();
}
