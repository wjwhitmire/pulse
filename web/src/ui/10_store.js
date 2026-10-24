// ---------------------------------------------------------------- state
const APP = {
  settings: SB.settingsWith(null),
  meta: new Map(),      // id -> activity metadata and summary row (small)
  streams: new Map(),   // id -> sample streams, cached on demand (always present for the example)
  daily: new Map(),     // day -> recovery row
  kv: null,
  example: false,
  selected: null,
  dbOk: true,
};
function defaultKv() { return { strength: [], body: [], cycle: [], journal: {}, gear: [], goals: [], segments: [], hr: [], sdnn: [], net: {}, cycleOverlay: false, dem: null, places: [], medical: [], ecg: [], coach: {}, custom: {}, auto: {} }; }
APP.kv = defaultKv();
const KV_KEYS = ["strength", "body", "cycle", "journal", "gear", "goals", "segments", "hr", "sdnn", "net", "settings", "cycleOverlay", "dem", "places", "medical", "ecg", "coach", "custom", "auto"];
const MAX_ACTIVITIES = 5000;

// ---------------------------------------------------------------- IndexedDB (this device only)
const DB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open("pulse", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
          if (!db.objectStoreNames.contains("streams")) db.createObjectStore("streams", { keyPath: "id" });
          if (!db.objectStoreNames.contains("daily")) db.createObjectStore("daily", { keyPath: "date" });
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
          if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("blocked"));
      } catch (e) { reject(e); }
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const t = db.transaction(store, mode), s = t.objectStore(store);
        let out;
        try { out = fn(s); } catch (e) { reject(e); return; }
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } catch (e) { APP.dbOk = false; return null; }
  }
  return {
    all: (store) => tx(store, "readonly", (s) => s.getAll()),
    get: (store, key) => tx(store, "readonly", (s) => s.get(key)),
    put: (store, val) => tx(store, "readwrite", (s) => s.put(val)),
    putMany: (store, vals) => tx(store, "readwrite", (s) => { for (const v of vals) s.put(v); }),
    del: (store, key) => tx(store, "readwrite", (s) => s.delete(key)),
    // true only when every store was cleared (tx returns null on failure)
    clear: async () => { let ok = true; for (const st of ["meta", "streams", "daily", "kv", "files"]) if ((await tx(st, "readwrite", (s) => s.clear())) === null) ok = false; return ok; },
  };
})();

async function loadAll() {
  const [meta, daily, kv] = await Promise.all([DB.all("meta"), DB.all("daily"), DB.all("kv")]);
  APP.meta.clear(); APP.daily.clear(); APP.streams.clear();
  APP.kv = defaultKv();
  for (const m of meta || []) APP.meta.set(m.id, m);
  for (const d of daily || []) APP.daily.set(d.date, d);
  for (const r of kv || []) {
    if (r.k === "settings") APP.settings = SB.settingsWith(r.v);
    else if (KV_KEYS.includes(r.k)) APP.kv[r.k] = r.v;
  }
  APP.dem = APP.kv.dem || null;
  APP.settingsSaved = (kv || []).some((r) => r.k === "settings");
  // Any saved entry (a lift, a weight, a journal answer) is the person's own log, even with no activities.
  APP.ownEntries = (kv || []).some((r) => !["settings", "net", "auto", "custom", "coach"].includes(r.k) && r.v && (Array.isArray(r.v) ? r.v.length : typeof r.v !== "object" || Object.keys(r.v).length));
}
async function saveKv(key) {
  if (APP.example && key !== "settings" && key !== "net") { setStatus("Example data is not saved. Import your own files to start your log; your entries then stay on this device."); return; }
  await DB.put("kv", { k: key, v: key === "settings" ? APP.settings : APP.kv[key] });
}
function hasUserData() { return !APP.example && (APP.meta.size > 0 || APP.daily.size > 0); }

async function getStreams(id) {
  if (APP.streams.has(id)) return APP.streams.get(id);
  const s = await DB.get("streams", id);
  if (s) { APP.streams.set(id, s.act); if (APP.streams.size > 40) APP.streams.delete(APP.streams.keys().next().value); return s.act; }
  return null;
}
function metaList() { return Array.from(APP.meta.values()).sort((a, b) => b.start - a.start); }
function rows() { return metaList().map((m) => m.row); }

// Activity record from an analysed activity. `an` is the analyze() output.
function makeMeta(act, an, extra) {
  const day = localDay(act.start);
  const thumb = [];
  if (act.lat && act.lat.length) {
    const step = Math.max(1, Math.floor(act.lat.length / 400));
    for (let i = 0; i < act.lat.length; i += step) if (act.lat[i] !== null) thumb.push([act.lat[i], act.lon[i]]);
  }
  const id = "a" + Math.round(act.start) + "-" + (act.source || "x");
  const m = Object.assign({ id, source: act.source, name: act.name || defaultName(act.sport, act.start), sport: act.sport, start: act.start,
    day, rpe: null, gear: null, file: null, summary_only: false, thumb, sig: an && an._sig ? an._sig : null, an: stripAn(an) }, extra || {});
  m.row = rowOf(m);
  return m;
}
function stripAn(an) {
  if (!an) return null;
  const o = {};
  for (const k of Object.keys(an)) if (k[0] !== "_") o[k] = an[k];
  return o;
}
function rowOf(m) {
  const an = m.an || {};
  return { id: m.id, day: m.day, sport: m.sport, name: m.name, distance: an.distance || 0, moving: an.moving || 0, elapsed: an.elapsed || 0,
    gain: an.elevation ? an.elevation.gain : (an.gain || 0), load: an.load === undefined ? null : an.load,
    kcal: an.calories ? an.calories.kcal : (an.kcal === undefined ? null : an.kcal), gear: m.gear,
    fastest: (an.fastest || []).map((b) => [b.distance, b.time]) };
}
function defaultName(sport, start) {
  const h = new Date(start * 1000).getHours();
  const part = h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
  return part + " " + (SPORT_NAME[sport] || "activity").toLowerCase();
}
function isDuplicate(start) {
  for (const m of APP.meta.values()) if (Math.abs(m.start - start) < 60) return m.id;
  return null;
}
