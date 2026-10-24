// ---------------------------------------------------------------- network features: one gate
// Every request Pulse can make goes through net() (fetch) or netScript()/netStyle() (a library).
// Each refuses unless the feature's switch is on and the URL's host is on that feature's list.
// With every switch off there is nothing to call, so the page makes no network requests.
const MAPLIBRE = { js: "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.js", jsSri: "sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj",
  css: "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.css", cssSri: "sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V" };
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const WEBLLM = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/lib/index.js";
// "Your own AI service": any service that speaks the OpenAI-compatible chat completions API, hosted
// or on this computer. The person types its base address, the model id and (unless it runs on this
// computer) a key. The gate then allows exactly one address: that service's chat completions URL.
const AI_SERVICE = { label: "Your own AI service (OpenAI-compatible API)", path: "/chat/completions" };
function aiEndpoint(base) {
  const raw = typeof base === "string" ? base.trim() : "";
  if (!raw) return { ok: false, why: "Type the service's base address, such as https://your-service.example/v1 or http://localhost:11434/v1." };
  if (/[@\s?#\\]/.test(raw)) return { ok: false, why: "The address cannot carry a user name, password, query or fragment." };
  const m = /^([Hh][Tt][Tt][Pp][Ss]?):\/\/([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(\/[A-Za-z0-9._~%\/-]*)?$/.exec(raw);
  if (!m || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(m[2].toLowerCase()) || (m[3] && Number(m[3]) > 65535)) return { ok: false, why: "That is not a web address." };
  const scheme = m[1].toLowerCase(), hostname = m[2].toLowerCase(), local = hostname === "localhost" || hostname === "127.0.0.1";
  if (!(scheme === "https" || local)) return { ok: false, why: "Use an https address, or http only for a server on this computer (localhost or 127.0.0.1)." };
  const port = m[3] && Number(m[3]) !== (scheme === "https" ? 443 : 80) ? ":" + Number(m[3]) : "";
  let path = (m[4] || "").replace(/\/+$/, "");
  if (!path.endsWith(AI_SERVICE.path)) path += AI_SERVICE.path;
  return { ok: true, url: scheme + "://" + hostname + port + path, host: hostname + port, local };
}
const AI_URLS = (sw) => { const e = aiEndpoint(sw.aiBase); return e.ok ? [e.url] : []; };
const NET_FEATURES = {
  maps: { title: "Maps", icon: "map", hosts: ["tiles.openfreemap.org", "cdnjs.cloudflare.com"],
    what: "Draws a street map under routes. Every map tile you look at is requested from tiles.openfreemap.org, so that host learns which area you view (often where you live and train) and your IP address. Loads the MapLibre map library once from cdnjs.cloudflare.com." },
  routing: { title: "Route finder", icon: "route", hosts: ["overpass-api.de"],
    what: "Plans routes on paths and streets. Sends the box around the points you place to overpass-api.de, so that host learns the area you are planning in and your IP address. No activity, name or health data is sent." },
  "ai-local": { title: "On-device coach", icon: "spark", hosts: ["cdn.jsdelivr.net", "huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs-us-1.huggingface.co", "cas-bridge.xethub.hf.co", "raw.githubusercontent.com"],
    what: "Downloads a small open model once (about 1 GB) from huggingface.co and its runtime from cdn.jsdelivr.net and raw.githubusercontent.com, then answers on this device. Your numbers never leave it. Needs WebGPU." },
  "ai-cloud": { title: "Coach with your own AI service", icon: "cloud", urls: AI_URLS, hosts: (sw) => AI_URLS(sw).map((u) => new URL(u).host),
    what: "Sends your question and the numbers the coach shows you to the AI service you set below (any service with an OpenAI-compatible chat completions API, hosted or on this computer), with your key, which is kept in memory only. Requests go only to that one address. That service's terms apply." },
};
function netSwitches() { return APP.kv.net || {}; }
// A switch turned on by the person's own click where the feature is used. The button sits next to
// the same host list Settings shows, so the choice is made with the same information.
async function switchOn(keys, msg) {
  APP.kv.net = Object.assign({}, APP.kv.net);
  for (const k of keys) APP.kv.net[k] = true;
  await saveKv("net");
  setStatus(msg);
  route();
}
async function net(feature, url, opts) {
  const d = SB.netDecision(NET_FEATURES, netSwitches(), feature, url);
  if (!d.ok) throw SB.err("net", "Blocked: " + d.reason + "." + (d.reason === "switch off" && NET_FEATURES[feature] ? " Turn on " + NET_FEATURES[feature].title + " to allow this request." : ""));
  return fetch(url, Object.assign({ credentials: "omit", referrerPolicy: "no-referrer", mode: "cors" }, opts || {}));
}
const LOADED = new Map();
function netScript(feature, url, sri) {
  const d = SB.netDecision(NET_FEATURES, netSwitches(), feature, url);
  if (!d.ok) return Promise.reject(SB.err("net", "Blocked: " + d.reason + "."));
  if (LOADED.has(url)) return LOADED.get(url);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url; s.integrity = sri; s.crossOrigin = "anonymous"; s.referrerPolicy = "no-referrer";
    s.addEventListener("load", resolve); s.addEventListener("error", () => reject(SB.err("net", "Could not load " + new URL(url).hostname + ".")));
    document.head.append(s);
  });
  LOADED.set(url, p);
  return p;
}
function netStyle(feature, url, sri) {
  const d = SB.netDecision(NET_FEATURES, netSwitches(), feature, url);
  if (!d.ok || LOADED.has(url)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = url; l.integrity = sri; l.crossOrigin = "anonymous"; l.referrerPolicy = "no-referrer";
  document.head.append(l);
  LOADED.set(url, Promise.resolve());
}
function netImport(feature, url) {
  const d = SB.netDecision(NET_FEATURES, netSwitches(), feature, url);
  if (!d.ok) return Promise.reject(SB.err("net", "Blocked: " + d.reason + "."));
  return import(url);
}
function renderNetwork() {
  const ul = clear($("network-list")), sw = netSwitches();
  const row = (key, title, ic, what, hostsText, toggle) => {
    const li = el("li", { cls: "set-row" }, [el("span", { cls: "ic" }, [icon(ic)]), el("span", { cls: "t", text: title })]);
    if (toggle) {
      const input = el("input", { type: "checkbox", id: "net-" + key, "aria-label": title });
      input.checked = sw[key] === true;
      input.addEventListener("change", async () => { APP.kv.net[key] = input.checked; await saveKv("net"); setStatus(title + (input.checked ? " is on." : " is off.")); renderNetwork(); });
      li.append(el("span", { cls: "switch" }, [input, el("span", { cls: "tr" }), el("span", { cls: "th" })]));
    } else li.append(el("span", { cls: "on-note" }, [icon("lock"), "No network."]));
    li.append(el("span", { cls: "d", text: what }));
    if (hostsText) li.append(el("span", { cls: "hosts", text: hostsText }));
    ul.append(li);
  };
  for (const k of Object.keys(NET_FEATURES)) {
    const f = NET_FEATURES[k];
    const hosts = typeof f.hosts === "function" ? f.hosts(sw) : f.hosts;
    row(k, f.title, f.icon, f.what, "Hosts: " + (hosts.length ? hosts.join(", ") : "the address you set below"), true);
  }
  // your own AI service: base address and model id (the key is typed where you ask, kept in memory only)
  const base = el("input", { id: "net-ai-base", type: "url", spellcheck: "false", value: sw.aiBase || "", placeholder: "https://your-service.example/v1 or http://localhost:11434/v1" });
  const model = el("input", { id: "net-ai-model", type: "text", spellcheck: "false", maxlength: "120", value: sw.aiModel || "", placeholder: "model id, as the service names it" });
  const note = el("span", { cls: "hosts", id: "net-ai-note", text: sw.aiBase ? (aiEndpoint(sw.aiBase).ok ? "Requests go only to " + aiEndpoint(sw.aiBase).url : aiEndpoint(sw.aiBase).why) : "Requests go only to the address you type here." });
  const saveAi = async () => {
    APP.kv.net = Object.assign({}, APP.kv.net, { aiBase: base.value.trim().slice(0, 300), aiModel: model.value.trim().slice(0, 120) });
    await saveKv("net");
    const e = aiEndpoint(APP.kv.net.aiBase);
    note.textContent = e.ok ? "Requests go only to " + e.url : e.why;
  };
  base.addEventListener("change", saveAi); model.addEventListener("change", saveAi);
  ul.append(el("li", { cls: "set-row" }, [el("span", { cls: "ic" }, [icon("cloud")]), el("span", { cls: "t", text: AI_SERVICE.label }), el("span"),
    el("span", { cls: "d form" }, [el("div", null, [el("label", { for: "net-ai-base", text: "Base address" }), base]), el("div", null, [el("label", { for: "net-ai-model", text: "Model id" }), model])]), note]));
  row("bt", "Bluetooth sensors", "bt", "Heart rate straps and blood pressure cuffs connect straight to this device over Bluetooth. Works in Chrome and Edge; Safari has no Web Bluetooth.", null, false);
  row("gps", "Recording with GPS", "gps", "Uses this device's location sensor while you record. Positions stay on the device.", null, false);
}

// ---------------------------------------------------------------- route planner (maps + route finder)
const PLAN = { map: null, points: [], graph: null, result: null, profile: "foot" };
function renderPlanner(root) {
  const sw = netSwitches();
  const card = el("article", { cls: "card c-12", id: "plan-card" }, [el("div", { cls: "card-h" }, [icon("route"), el("h3", { text: "Plan a route" })])]);
  root.append(card);
  if (!sw.maps || !sw.routing) {
    card.append(el("p", { cls: "muted", text: "Route planning uses two network features that are off: Maps (map tiles from tiles.openfreemap.org, which learns the area you view) and Route finder (paths from overpass-api.de, which learns the area you plan in). Both see your IP address. Nothing about your activities or health is sent." }),
      el("div", { cls: "btn-row" }, [el("button", { type: "button", cls: "btn primary", id: "plan-enable", text: "Turn on Maps and Route finder", onclick: () => switchOn(["maps", "routing"], "Maps and Route finder are on. Turn them off in Settings at any time.") }),
        el("a", { cls: "btn ghost", href: "#settings", text: "Settings" })]));
    return;
  }
  const seg = el("div", { cls: "seg", role: "group", "aria-label": "Profile" });
  for (const [k, l] of [["foot", "On foot"], ["bike", "By bike"]]) {
    const b = el("button", { type: "button", "aria-pressed": PLAN.profile === k ? "true" : "false", text: l });
    b.addEventListener("click", () => { PLAN.profile = k; PLAN.graph = null; for (const x of seg.children) x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    seg.append(b);
  }
  const mapDiv = el("div", { cls: "map", id: "plan-map" });
  const info = el("p", { cls: "muted", id: "plan-info", text: "Tap the map to add points, then find the route. Or set a distance and ask for loops from the first point." });
  const dist = el("input", { id: "plan-loop", type: "number", min: "1", max: "200", step: "0.5", value: "10" });
  const go = el("button", { type: "button", cls: "btn primary", text: "Find route" });
  const loop = el("button", { type: "button", cls: "btn", text: "Suggest loops" });
  const clr = el("button", { type: "button", cls: "btn ghost", text: "Clear" });
  const gpx = el("button", { type: "button", cls: "btn", text: "Export GPX" });
  card.append(el("div", { cls: "seg-wrap" }, [seg]), mapDiv, info,
    el("div", { cls: "form" }, [el("div", null, [el("label", { for: "plan-loop", text: "Loop distance (km)" }), dist])]),
    el("div", { cls: "btn-row" }, [go, loop, gpx, clr]),
    el("p", { cls: "muted small", text: "Map data from OpenStreetMap contributors (ODbL) via OpenFreeMap and the Overpass API. Routing runs on this device." }));
  netStyle("maps", MAPLIBRE.css, MAPLIBRE.cssSri);
  netScript("maps", MAPLIBRE.js, MAPLIBRE.jsSri).then(() => {
    const ml = window.maplibregl;
    const c = planCentre();
    PLAN.map = new ml.Map({ container: mapDiv, style: MAP_STYLE, center: [c[1], c[0]], zoom: 13, attributionControl: { compact: true },
      transformRequest: (url) => (SB.netDecision(NET_FEATURES, netSwitches(), "maps", url).ok ? { url } : { url: "data:application/json,{}" }) });
    PLAN.map.on("click", (e) => { PLAN.points.push([e.lngLat.lat, e.lngLat.lng]); drawPlan(); });
    PLAN.map.on("load", drawPlan);
  }).catch((e) => { info.textContent = e.message; });
  go.addEventListener("click", async () => {
    if (PLAN.points.length < 2) { info.textContent = "Add at least two points."; return; }
    try { await ensureGraph(info); const r = PulseRoute.routeVia(PLAN.graph, PLAN.points, {}); if (r.error) { info.textContent = r.error === "snap" ? "Point " + (r.waypoint + 1) + " is more than 300 m from any path. Move it onto a path." : "No path reaches point " + (r.waypoint + 1) + " from the point before it."; return; } PLAN.result = r; info.textContent = "Route: " + fmtDist(r.distance) + "."; drawPlan(); }
    catch (e) { info.textContent = e.message; }
  });
  loop.addEventListener("click", async () => {
    if (!PLAN.points.length) { info.textContent = "Tap a start point first."; return; }
    try {
      await ensureGraph(info, parseFloat(dist.value) * 1000);
      const s = PulseRoute.nearestNode(PLAN.graph, PLAN.points[0][0], PLAN.points[0][1], 300);
      if (!s) { info.textContent = "No path within 300 m of the start point."; return; }
      const loops = PulseRoute.suggestLoops(PLAN.graph, s.index, parseFloat(dist.value) * 1000, {});
      if (!loops.length) { info.textContent = "No loop within 25 % of that distance here."; return; }
      PLAN.result = loops[0]; info.textContent = "Loop: " + fmtDist(loops[0].distance) + " (best of " + loops.length + ")."; drawPlan();
    } catch (e) { info.textContent = e.message; }
  });
  gpx.addEventListener("click", () => { if (PLAN.result) saveBlob(new Blob([PulseRoute.toGpx(PLAN.result.coords, { name: "Pulse route" })], { type: "application/gpx+xml" }), "pulse-route.gpx", $("ex-out")); });
  clr.addEventListener("click", () => { PLAN.points = []; PLAN.result = null; drawPlan(); });
}
function planCentre() {
  // The middle of the latest track, not its start: starts are usually home, and the first tiles
  // requested would point straight at it.
  const m = metaList().find((x) => x.thumb && x.thumb.length);
  return m ? m.thumb[Math.floor(m.thumb.length / 2)] : [51.5074, -0.1278];
}
async function ensureGraph(info, loopM) {
  const pts = PLAN.points.slice();
  let s = Math.min(...pts.map((p) => p[0])), n = Math.max(...pts.map((p) => p[0])), w = Math.min(...pts.map((p) => p[1])), e = Math.max(...pts.map((p) => p[1]));
  const pad = loopM ? loopM / 2 / 111000 * 1.3 : 0.01;
  s -= pad; n += pad; w -= pad / Math.cos(s * Math.PI / 180); e += pad / Math.cos(s * Math.PI / 180);
  info.textContent = "Fetching paths for this area from overpass-api.de.";
  const q = PulseRoute.overpassQuery(s, w, n, e, PLAN.profile);
  const r = await net("routing", "https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (!r.ok) throw SB.err("net", "The route finder answered " + r.status + ".");
  const text = await r.text();
  if (text.length > 60 * 1024 * 1024) throw SB.err("size", "That area is too large; zoom in.");
  PLAN.graph = PulseRoute.buildGraph(JSON.parse(text), { profile: PLAN.profile });
}
function drawPlan() {
  const map = PLAN.map;
  if (!map || !map.isStyleLoaded || !map.isStyleLoaded()) return;
  const line = PLAN.result ? PLAN.result.coords.map(([a, b]) => [b, a]) : [];
  const data = { type: "FeatureCollection", features: [] };
  if (line.length > 1) data.features.push({ type: "Feature", geometry: { type: "LineString", coordinates: line }, properties: {} });
  for (const p of PLAN.points) data.features.push({ type: "Feature", geometry: { type: "Point", coordinates: [p[1], p[0]] }, properties: {} });
  if (map.getSource("plan")) map.getSource("plan").setData(data);
  else {
    map.addSource("plan", { type: "geojson", data });
    map.addLayer({ id: "plan-line", type: "line", source: "plan", filter: ["==", "$type", "LineString"], paint: { "line-color": tokenColor("--route"), "line-width": 5 } });
    map.addLayer({ id: "plan-pts", type: "circle", source: "plan", filter: ["==", "$type", "Point"], paint: { "circle-color": tokenColor("--accent"), "circle-radius": 7, "circle-stroke-color": tokenColor("--surface"), "circle-stroke-width": 3 } });
  }
}

// ---------------------------------------------------------------- coach (on device, or your own key)
const COACH = { engine: null, history: [], loading: false };
function coachPack() {
  const c = context();
  const daily = c.daily.map((d) => ({ date: d.date, rhr: d.rhr, rmssd: d.rmssd, sdnn: d.sdnn, sleep: d.sleep, load: c.loads.get(d.date) || 0 }));
  for (const b of APP.kv.body) { const r = daily.find((x) => x.date === b.date); if (r) { if (b.kg) r.weight = b.kg; if (b.sys) { r.sys = b.sys; r.dia = b.dia; } } }
  const acts = metaList().slice(0, 300).map((m) => ({ date: m.day, sport: m.sport, durationMin: m.row.moving / 60, distanceKm: m.row.distance / 1000, load: m.row.load, avgHr: m.an && m.an.hr ? m.an.hr.avg : null }));
  return PulseCoach.buildPack({ daily, activities: acts, readiness: { state: c.ready.state, flags: c.ready.flags } }, { today: SB.dayStr(c.day), days: 28 });
}
function renderCoach(node) {
  clear(node);
  const sw = netSwitches();
  node.append(el("div", { cls: "card-h" }, [icon("spark"), el("h3", { text: "Ask about your numbers" })]));
  if (typeof PulseCoach === "undefined") { node.append(el("p", { cls: "muted", text: "The coach module is not part of this build." })); return; }
  if (!sw["ai-local"] && !sw["ai-cloud"]) {
    node.append(el("p", { cls: "muted", text: "The coach is off. On this device: downloads a small model once (about 1 GB) from huggingface.co, cdn.jsdelivr.net and raw.githubusercontent.com, then your numbers never leave the device; needs WebGPU. With your own AI service: sends your question and the numbers shown to the address you set (any OpenAI-compatible service, or one on this computer). Each host sees your IP address." }),
      el("div", { cls: "btn-row" }, [
        el("button", { type: "button", cls: "btn primary", id: "coach-enable-local", text: navigator.gpu ? "Use the on-device coach" : "On-device coach (needs WebGPU)", disabled: navigator.gpu ? null : "true", onclick: () => switchOn(["ai-local"], "On-device coach is on. Turn it off in Settings at any time.") }),
        el("button", { type: "button", cls: "btn", id: "coach-enable-cloud", text: "Use my own AI service", onclick: () => switchOn(["ai-cloud"], "Coach with your own AI service is on. Set its address and model id below, then paste your key.") }),
        el("a", { cls: "btn ghost", href: "#settings", text: "Settings" })]));
    return;
  }
  const log = el("ul", { cls: "rows", id: "coach-log", "aria-live": "polite" });
  const q = el("textarea", { id: "coach-q", rows: "2", maxlength: "500", "aria-label": "Your question" });
  const keyIn = el("input", { id: "coach-key", type: "password", autocomplete: "new-password", spellcheck: "false", placeholder: "API key (kept in memory only)", "aria-label": "API key" });
  const ask = el("button", { type: "button", cls: "btn primary", text: "Ask" });
  const showPack = el("details", null, [el("summary", { text: "The numbers the coach sees" }), el("pre", { cls: "outbox", id: "coach-pack" })]);
  node.append(log, el("div", { cls: "form" }, [el("div", null, [el("label", { for: "coach-q", text: "Question" }), q])].concat(sw["ai-cloud"] && !sw["ai-local"] ? aiFields(sw, keyIn) : [])),
    el("div", { cls: "btn-row" }, [ask]), showPack,
    el("p", { cls: "notice" }, [icon("info"), el("span", { text: PulseCoach.SYMPTOM_NOTICE || "Not medical advice. For symptoms, see a clinician." })]));
  let pack = null;
  try { pack = coachPack(); $("coach-pack").textContent = PulseCoach.packText(pack); } catch (e) { $("coach-pack").textContent = e.message; }
  const say = (who, text) => log.append(el("li", null, [el("span", { cls: "grow" }, [el("span", { cls: "label", text: who }), el("span", { cls: "sub", text })])]));
  for (const [who, t] of COACH.history.map((m) => [m.role === "user" ? "You" : "Coach", m.content])) say(who, t);
  ask.addEventListener("click", async () => {
    const text = q.value.trim().slice(0, 500);
    if (!text || !pack) return;
    const chk = PulseCoach.checkQuestion(text);
    say("You", text);
    if (chk.symptom) say("Pulse", chk.notice);
    const msgs = PulseCoach.buildMessages(pack, COACH.history, text, {});
    ask.disabled = true;
    try {
      const raw = sw["ai-local"] ? await localReply(msgs) : await cloudReply(msgs, keyIn.value);
      const reply = PulseCoach.guardOutput(raw, {});
      const out = typeof reply === "string" ? reply : reply.text;
      COACH.history.push({ role: "user", content: text }, { role: "assistant", content: out });
      say("Coach", out);
      q.value = "";
    } catch (e) { say("Pulse", e.message); }
    ask.disabled = false;
  });
}
async function localReply(msgs) {
  if (!navigator.gpu) throw SB.err("gpu", "This browser has no WebGPU, which the on-device coach needs. Chrome or Edge on a recent computer works.");
  if (!COACH.engine) {
    setStatus("Loading the on-device model. The first time downloads about 1 GB; later it opens from the browser's cache.");
    const webllm = await netImport("ai-local", WEBLLM);
    COACH.engine = await webllm.CreateMLCEngine("Qwen2.5-1.5B-Instruct-q4f16_1-MLC", { initProgressCallback: (p) => setStatus("Model: " + Math.round((p.progress || 0) * 100) + "%") });
    setStatus("");
  }
  const r = await COACH.engine.chat.completions.create({ messages: msgs, temperature: 0.3, max_tokens: 400 });
  return r.choices[0].message.content;
}
// Base address and model id set right here when they are missing, so asking never dead-ends.
function aiFields(sw, keyIn) {
  const out = [];
  if (!aiEndpoint(sw.aiBase).ok || !sw.aiModel) {
    out.push(el("div", null, [el("label", { for: "coach-base", text: "AI service base address" }), el("input", { id: "coach-base", type: "url", spellcheck: "false", value: sw.aiBase || "", placeholder: "https://your-service.example/v1 or http://localhost:11434/v1" })]),
      el("div", null, [el("label", { for: "coach-model", text: "Model id" }), el("input", { id: "coach-model", type: "text", spellcheck: "false", maxlength: "120", value: sw.aiModel || "" })]));
  }
  out.push(el("div", null, [el("label", { for: "coach-key", text: "Your key (none needed for a server on this computer)" }), keyIn]));
  return out;
}
async function cloudReply(msgs, key) {
  if ($("coach-base")) {
    APP.kv.net = Object.assign({}, APP.kv.net, { aiBase: $("coach-base").value.trim().slice(0, 300), aiModel: $("coach-model").value.trim().slice(0, 120) });
    await saveKv("net");
  }
  const sw = netSwitches(), ep = aiEndpoint(sw.aiBase);
  if (!ep.ok) throw SB.err("ai", ep.why);
  const model = (sw.aiModel || "").trim();
  if (!/^[A-Za-z0-9._:\/@+-]{1,120}$/.test(model)) throw SB.err("ai", "Type the model id the service uses.");
  key = (key || "").trim();
  if (/[\r\n]/.test(key)) throw SB.err("key", "The key cannot hold a line break.");
  if (!ep.local && key.length < 10) throw SB.err("key", "Paste your API key. It is kept in memory for this page only.");
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = "Bearer " + key;
  const r = await net("ai-cloud", ep.url, { method: "POST", headers, body: JSON.stringify({ model, messages: msgs, max_tokens: 1024 }) });
  if (!r.ok) throw SB.err("net", "The AI service answered " + r.status + ".");
  const j = await r.json();
  return j && j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || "") : "";
}
