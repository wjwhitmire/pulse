// ---------------------------------------------------------------- heavy work off the main thread
// The worker is built from a blob URL holding the core script plus makeOps; with no Worker support
// the same operations run on the main thread.
function makeOps(SB) {
  async function sliceBytes(file, a, b) { return new Uint8Array(await file.slice(a, b).arrayBuffer()); }
  async function zipEntries(file) {
    const ts = Math.max(0, file.size - 65557 - 76);
    const end = SB.zipEnd(await sliceBytes(file, ts, file.size), ts);
    if (end.size > 64 * 1024 * 1024) throw SB.err("zip", "The zip directory is too large.");
    return SB.zipCentral(await sliceBytes(file, end.offset, end.offset + end.size));
  }
  async function entryStream(file, ent, onBytes) {
    if (ent.method !== 0 && ent.method !== 8) throw SB.err("zip", "Unsupported compression method in " + ent.name + ".");
    const off = SB.zipDataOffset(await sliceBytes(file, ent.lho, ent.lho + 30), ent.lho);
    let raw = file.slice(off, off + ent.csize).stream();
    if (onBytes) {
      raw = raw.pipeThrough(new TransformStream({ transform(chunk, c) { onBytes(chunk.byteLength); c.enqueue(chunk); } }));
    }
    if (ent.method !== 8) return raw;
    // Zip bomb guard: stop when the inflated bytes pass what the directory declared, or 100 times the
    // compressed size (real Health exports are far below that; deflate bombs reach about 1,000).
    const limit = Math.min(ent.usize || Infinity, 100 * ent.csize + 64 * 1024 * 1024);
    let out = 0;
    return raw.pipeThrough(new DecompressionStream("deflate-raw")).pipeThrough(new TransformStream({ transform(chunk, c) {
      out += chunk.byteLength;
      if (out > limit) throw SB.err("zip", ent.name + " inflates past its declared size; the zip is damaged or a zip bomb.");
      c.enqueue(chunk);
    } }));
  }
  async function readAll(stream, limit) {
    const reader = stream.getReader(), parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > limit) { try { reader.cancel(); } catch (e) {} throw SB.err("size", "A file inside the zip is larger than " + Math.round(limit / 1048576) + " MB."); }
      parts.push(value);
    }
    const out = new Uint8Array(n);
    let p = 0;
    for (const v of parts) { out.set(v, p); p += v.byteLength; }
    return out;
  }
  function strip(an) { const o = {}; for (const k of Object.keys(an)) if (k[0] !== "_") o[k] = an[k]; return o; }
  function analyzeOne(act, settings, rpe) {
    const an = SB.analyze(act, settings, rpe);
    const out = strip(an);
    out._sig = SB.signature(act, an._d);
    return out;
  }
  return {
    decodeFit(bytes, settings) { const act = SB.decodeFit(bytes); return { act, an: act.t.length >= 2 ? analyzeOne(act, settings, null) : null }; },
    analyze(act, settings, rpe) { return analyzeOne(act, settings, rpe); },
    example(endDay, settings) {
      const [acts, daily] = SB.generateExample(endDay, 90);
      return { acts, daily, an: acts.map((a) => analyzeOne(a, settings, null)) };
    },
    async zipList(file) { return zipEntries(file); },
    async zipRead(file, ent, gz) {
      let st = await entryStream(file, ent);
      if (gz) st = st.pipeThrough(new DecompressionStream("gzip"));
      return readAll(st, SB.MAX_ACTIVITY_BYTES * 4);
    },
    async gunzip(bytes) { return readAll(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")), SB.MAX_ACTIVITY_BYTES * 4); },
    async health(file, progress) {
      if (file.size > SB.MAX_HEALTH_BYTES) throw SB.err("size", "The Health export is over the 200 MB limit.");
      const head = await sliceBytes(file, 0, 4);
      let stream, total = file.size, done = 0, routes = [], clinical = [], ecgs = [];
      const tick = (n) => { done += n; progress(Math.min(1, done / total)); };
      if (head[0] === 0x50 && head[1] === 0x4B) {
        const entries = await zipEntries(file);
        const name = SB.findExportName(entries.map((e) => e.name));
        if (!name) throw SB.err("zip", "No export.xml inside the zip.");
        const ent = entries.find((e) => e.name === name);
        total = ent.csize || 1;
        stream = await entryStream(file, ent, tick);
        routes = entries.filter((e) => /workout-routes\/[^/]+\.gpx$/i.test(e.name) && e.usize < SB.MAX_ACTIVITY_BYTES);
        clinical = entries.filter((e) => /clinical-records\/[^/]+\.json$/i.test(e.name) && e.usize < 32 * 1024 * 1024).slice(0, 5000);
        ecgs = entries.filter((e) => /electrocardiograms\/[^/]+\.csv$/i.test(e.name) && e.usize < 20 * 1024 * 1024).slice(-50);
      } else {
        stream = file.stream().pipeThrough(new TransformStream({ transform(chunk, c) { tick(chunk.byteLength); c.enqueue(chunk); } }));
      }
      const sc = SB.HealthScanner();
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d) break;
        sc.feed(value);
      }
      return { days: sc.result(), extras: sc.extras(), records: sc.records, routes, clinical, ecgs };
    },
  };
}

const WORK = (() => {
  let worker = null, seq = 0, broken = false;
  const pending = new Map();
  let localOps = null;
  function start() {
    if (worker || broken) return worker;
    try {
      const src = document.getElementById("core").textContent + "\nconst OPS = (" + makeOps.toString() + ")(SB);\n" +
        "self.onmessage = async (ev) => { const { id, op, args } = ev.data;" +
        " try { const out = await OPS[op](...args, (p) => self.postMessage({ id, progress: p })); self.postMessage({ id, ok: out }); }" +
        " catch (e) { self.postMessage({ id, error: String(e && e.message || e), code: e && e.code }); } };";
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onmessage = (ev) => {
        const m = ev.data, p = pending.get(m.id);
        if (!p) return;
        if ("progress" in m) { if (p.onProgress) p.onProgress(m.progress); return; }
        pending.delete(m.id);
        if ("error" in m) { const e = new Error(m.error); e.code = m.code; p.reject(e); } else p.resolve(m.ok);
      };
      worker.onerror = () => { broken = true; for (const p of pending.values()) p.reject(new Error("worker failed")); pending.clear(); worker = null; };
    } catch (e) { broken = true; worker = null; }
    return worker;
  }
  function run(op, args, onProgress) {
    const w = start();
    if (!w) {
      localOps = localOps || makeOps(SB);
      return Promise.resolve().then(() => localOps[op](...args, onProgress || (() => {})));
    }
    const id = ++seq;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onProgress }); w.postMessage({ id, op, args }); });
  }
  function cancel() {
    if (worker) { worker.terminate(); worker = null; }
    for (const p of pending.values()) { const e = new Error("Cancelled."); e.code = "cancel"; p.reject(e); }
    pending.clear();
  }
  return { run, cancel };
})();
