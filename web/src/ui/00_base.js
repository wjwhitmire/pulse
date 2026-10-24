"use strict";
// Pulse UI. User text is only ever set with textContent; numbers come from our own formatters.
const $ = (id) => document.getElementById(id);
function el(tag, attrs, kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") e.textContent = v;
    else if (k === "cls") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids || []) if (c !== null && c !== undefined) e.append(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
function setStatus(msg) { $("status").textContent = msg || ""; }
function safe(fn) { try { return fn(); } catch (e) { return null; } }

// ---------------------------------------------------------------- formatting
const UNIT = () => (APP.settings.units === "mi" ? { len: 1609.344, name: "mi", small: "ft", smallK: 3.28084 } : { len: 1000, name: "km", small: "m", smallK: 1 });
function fmtDur(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return "-";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0") : m + ":" + String(x).padStart(2, "0");
}
function fmtDist(m, dp) { if (m === null || m === undefined) return "-"; return (m / UNIT().len).toFixed(dp === undefined ? 2 : dp) + " " + UNIT().name; }
function fmtPace(speed) {
  if (!speed || speed <= 0) return "-";
  return fmtDur(UNIT().len / speed) + " /" + UNIT().name;
}
function fmtSpeed(speed) { if (!speed) return "-"; return (speed * 3600 / UNIT().len).toFixed(1) + " " + UNIT().name + "/h"; }
function fmtPaceOrSpeed(sport, speed) { return sport === "run" ? fmtPace(speed) : fmtSpeed(speed); }
function fmtElev(m) { if (m === null || m === undefined) return "-"; return Math.round(m * UNIT().smallK) + " " + UNIT().small; }
const fx = (v, dp) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(dp));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(z) { const [y, m, d] = SB.civilFromDays(z); return d + " " + MONTHS[m - 1] + " " + y; }
function fmtDayShort(z) { const [, m, d] = SB.civilFromDays(z); return d + " " + MONTHS[m - 1]; }
function localDay(ts) { const d = new Date(ts * 1000); return SB.daysFromCivil(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
function todayDay() { return localDay(Date.now() / 1000); }
function fmtClockTs(ts) { const d = new Date(ts * 1000); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
function dayFromInput(v) { return SB.parseDay(v); }
function inputFromDay(z) { return SB.dayStr(z); }
const SPORT_NAME = { run: "Run", ride: "Ride", strength: "Strength", other: "Other" };

// ---------------------------------------------------------------- icons (constant markup, never user text)
const ICONS = /*ICONS*/;
function icon(name, cls) {
  const doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" class="' + (cls || "i") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>", "image/svg+xml");
  return document.importNode(doc.documentElement, true);
}

// ---------------------------------------------------------------- numbers with units, tables, stats
function numEl(value, unit, cls) {
  const n = el("span", { cls: "num" + (cls ? " " + cls : ""), text: value });
  if (unit) n.append(el("small", { text: unit }));
  return n;
}
// cols: [{h, cls}] ; rows: arrays of strings or Nodes
function table(node, head, rows, opts) {
  clear(node);
  opts = opts || {};
  const cls = opts.cls || [];
  const thead = el("thead", null, [el("tr", null, head.map((h, i) => el("th", { scope: "col", cls: cls[i] || null, text: h })))]);
  const tb = el("tbody");
  rows.forEach((r, i) => {
    const tr = el("tr", opts.onRow ? { cls: "clickable", tabindex: "0" } : null,
      r.map((c, j) => (c instanceof Node ? el("td", { cls: cls[j] || null }, [c]) : el("td", { cls: cls[j] || null, text: c === null || c === undefined ? "-" : String(c) }))));
    if (opts.onRow) {
      tr.addEventListener("click", () => opts.onRow(i));
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onRow(i); } });
    }
    if (opts.best === i) tr.classList.add("best");
    tb.append(tr);
  });
  if (!rows.length) tb.append(el("tr", null, [el("td", { colspan: String(head.length), cls: "txt", text: opts.empty || "Nothing yet." })]));
  node.append(thead, tb);
}
// items: [label, value, unit, keyed]
function stats(node, items) {
  clear(node);
  for (const [l, v, u, keyed] of items) node.append(el("div", { cls: "stat" + (keyed ? " keyed" : "") }, [el("span", { cls: "label", text: l }), numEl(v, u)]));
}

// ---------------------------------------------------------------- charts: stretched SVG plot, HTML labels
const SVGNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const k of Object.keys(attrs || {})) e.setAttribute(k, attrs[k]); return e; }
function niceTicks(lo, hi, n) {
  if (!(hi > lo)) hi = lo + 1;
  const step0 = (hi - lo) / (n || 4), mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= step0) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < 1e-12 ? 0 : v);
  return out;
}
const pos = (f) => "calc(34px + (100% - 34px) * " + f.toFixed(4) + ")";
// opts: x[], series [{y[], cls, dots, area}], bars [{y[], cur (index)}], band {lo[], hi[]}, overlays [[x0,x1]],
// zones [[lo, hi, n]], xfmt, yfmt, tall, short, zero, ymin, ymax, key {i, label} (the one --mark marker)
function chart(node, opts) {
  clear(node);
  const x = opts.x;
  node.className = "chart" + (opts.tall ? " tall" : "") + (opts.short ? " short" : "");
  if (!x || x.length < 2) { node.className = ""; node.append(el("p", { cls: "empty-note", text: opts.empty || "Not enough data for this chart yet." })); return; }
  let lo = Infinity, hi = -Infinity;
  const take = (arr) => { for (const v of arr || []) if (v !== null && v !== undefined && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
  (opts.series || []).forEach((se) => take(se.y));
  (opts.bars || []).forEach((b) => take(b.y));
  if (opts.band) { take(opts.band.lo); take(opts.band.hi); }
  if (opts.zero || (opts.bars && opts.bars.length)) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (opts.ymin !== undefined) lo = opts.ymin;
  if (opts.ymax !== undefined) hi = opts.ymax;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { node.className = ""; node.append(el("p", { cls: "empty-note", text: opts.empty || "No values to chart." })); return; }
  if (hi === lo) { hi += 1; lo -= 1; }
  const ticks = niceTicks(lo, hi, 4);
  lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const x0 = x[0], x1 = x[x.length - 1] === x0 ? x0 + 1 : x[x.length - 1];
  const fx_ = (v) => (v - x0) / (x1 - x0), fy = (v) => (hi - v) / (hi - lo);
  const X = (v) => (fx_(v) * 100).toFixed(3), Y = (v) => (fy(v) * 100).toFixed(3);
  const s = svg("svg", { class: "plot", viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" });
  for (const [a, b] of opts.overlays || []) s.append(svg("rect", { class: "ov", x: X(Math.max(a, x0)), y: 0, width: Math.max(0, X(Math.min(b, x1)) - X(Math.max(a, x0))), height: 100 }));
  for (const [zlo, zhi, k] of opts.zones || []) s.append(svg("rect", { class: "zb zb" + k, x: 0, width: 100, y: Y(Math.min(zhi, hi)), height: Math.max(0, Y(Math.max(zlo, lo)) - Y(Math.min(zhi, hi))) }));
  const g = svg("g", { class: "grid" });
  for (const t of ticks) g.append(svg("line", { x1: 0, x2: 100, y1: Y(t), y2: Y(t) }));
  s.append(g);
  if (opts.band) {
    let d = "", back = "";
    x.forEach((xv, i) => {
      const a = opts.band.lo[i], b = opts.band.hi[i];
      if (a === null || b === null || a === undefined || b === undefined) return;
      d += (d ? "L" : "M") + X(xv) + "," + Y(b);
      back = "L" + X(xv) + "," + Y(a) + back;
    });
    if (d) s.append(svg("path", { class: "s-band", d: d + back + "Z" }));
  }
  for (const b of opts.bars || []) {
    const bw = Math.max(0.15, 100 / x.length * 0.7);
    const grp = svg("g", { class: "bars" });
    b.y.forEach((v, i) => {
      if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return;
      const yv = Y(Math.max(v, 0)), y0 = Y(Math.min(v, 0));
      grp.append(svg("rect", { class: i === b.cur ? "cur" : "", x: (X(x[i]) - bw / 2).toFixed(3), y: yv, width: bw.toFixed(3), height: Math.max(0.3, y0 - yv).toFixed(3) }));
    });
    s.append(grp);
  }
  for (const se of opts.series || []) {
    let d = "", pen = false, first = null, last = null;
    se.y.forEach((v, i) => {
      if (v === null || v === undefined || !Number.isFinite(v)) { pen = false; return; }
      if (se.dots) { s.append(svg("ellipse", { class: "s-dot", cx: X(x[i]), cy: Y(v), rx: 0.45, ry: 1.6 })); return; }
      d += (pen ? "L" : "M") + X(x[i]) + "," + Y(v); pen = true;
      if (first === null) first = i; last = i;
    });
    if (se.area && d) s.append(svg("path", { class: "s-area", d: d + "L" + X(x[last]) + "," + Y(Math.max(lo, 0)) + "L" + X(x[first]) + "," + Y(Math.max(lo, 0)) + "Z" }));
    if (!se.dots && d) s.append(svg("path", { class: se.cls || "s-1", d }));
  }
  node.append(s);
  for (const t of ticks) {
    const l = el("span", { cls: "yl", text: (opts.yfmt || ((v) => String(+v.toFixed(2))))(t) });
    l.style.top = "calc((100% - 22px) * " + fy(t).toFixed(4) + ")";
    node.append(l);
  }
  const xt = opts.xticks || niceTicks(x0, x1, 5).filter((t) => t >= x0 && t <= x1);
  xt.forEach((t, k) => {
    const l = el("span", { cls: "xl" + (k === 0 && fx_(t) < 0.05 ? " first" : "") + (k === xt.length - 1 && fx_(t) > 0.95 ? " last" : ""), text: (opts.xfmt || ((v) => String(+v.toFixed(1))))(t) });
    l.style.left = pos(fx_(t));
    node.append(l);
  });
  if (opts.key && opts.key.i !== undefined) {
    const se = (opts.series || [])[0], v = se ? se.y[opts.key.i] : null;
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      const pt = el("i", { cls: "pt" }); pt.style.left = pos(fx_(x[opts.key.i])); pt.style.top = "calc((100% - 22px) * " + fy(v).toFixed(4) + ")";
      const lb = el("span", { cls: "pt-label", text: opts.key.label }); lb.style.left = pt.style.left; lb.style.top = pt.style.top;
      node.append(pt, lb);
    }
  }
}
function zoneBar(node, label, secs, names) {
  if (!secs) return;
  const tot = secs.reduce((a, b) => a + b, 0);
  if (!tot) return;
  const wrap = el("div", { cls: "zone-block" });
  if (label) wrap.append(el("p", { cls: "label", text: label }));
  const bar = el("div", { cls: "zonebar", role: "img", "aria-label": label + ": " + secs.map((v, i) => names[i] + " " + fmtDur(v)).join(", ") });
  const leg = el("ul", { cls: "zlegend" });
  leg.style.gridTemplateColumns = "repeat(" + Math.min(secs.length, 5) + ",minmax(0,1fr))";
  secs.forEach((v, i) => {
    const z = "z" + Math.min(5, Math.max(1, i + (secs.length > 5 ? 0 : 1) - (secs.length === 6 ? 1 : 0)));
    const sp = el("span", { cls: z }); sp.style.flex = String(v);
    bar.append(sp);
    leg.append(el("li", null, [el("span", { cls: "sw" }, [el("i", { cls: z }), names[i]]), el("span", { cls: "t", text: fmtDur(v) })]));
  });
  wrap.append(bar, leg);
  node.append(wrap);
}

// ---------------------------------------------------------------- clipboard and saving
async function copyText(text, fallbackArea) {
  try { await navigator.clipboard.writeText(text); setStatus("Copied to the clipboard."); if (fallbackArea) fallbackArea.hidden = true; return true; }
  catch (e) {
    if (fallbackArea) { fallbackArea.hidden = false; fallbackArea.value = text; fallbackArea.focus(); fallbackArea.select(); }
    setStatus("Clipboard not available here. The text is selected below; copy it from there.");
    return false;
  }
}
async function saveBlob(blob, name, fallbackArea) {
  // Prefer the File System Access save dialog; otherwise a temporary object URL link.
  try {
    if (window.showSaveFilePicker) {
      const h = await window.showSaveFilePicker({ suggestedName: name });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      setStatus("Saved " + name + "."); return;
    }
  } catch (e) { if (e && e.name === "AbortError") return; }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setStatus("Saving " + name + ".");
  } catch (e) {
    if (fallbackArea && blob.size < 5e6) { fallbackArea.hidden = false; fallbackArea.value = await blob.text(); setStatus("Saving is blocked here; the export is shown below."); }
    else setStatus("Saving is blocked in this view. Open Pulse in its own tab to export.");
  }
}
