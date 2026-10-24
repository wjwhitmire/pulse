// PulseRecord: live GPS track processing core. Accuracy filter, speed-spike
// rejection, auto-pause with hysteresis, haversine distance with smoothing,
// laps, live splits and current pace. Pure: the app feeds fixes from
// navigator.geolocation.watchPosition and renders what this returns.
// Times are milliseconds (the Geolocation API timestamp unit).
var PulseRecord = (function () {
  "use strict";

  var R = 6371008.8; // mean Earth radius, m (IUGG)
  function rad(d) { return d * Math.PI / 180; }
  function haversine(a, b) {
    var p1 = rad(a.lat), p2 = rad(b.lat), dp = p2 - p1, dl = rad(b.lon - a.lon);
    var s1 = Math.sin(dp / 2), s2 = Math.sin(dl / 2);
    var h = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
  }

  var SPORT_MAX_SPEED = { run: 12, walk: 6, hike: 6, ride: 30, other: 30 }; // m/s
  var DEFAULTS = {
    sport: "run",
    maxAccuracy: 30,       // m; fixes with worse horizontal accuracy are dropped
    maxSpeed: null,        // m/s; null = by sport
    spikeReseed: 4,        // consecutive self-consistent spike rejects that re-anchor
    smoothN: 3,            // moving-average length for position smoothing
    minStep: 3,            // m; smoothed movement below this is held, not counted (jitter)
    speedWindow: 5000,     // ms over which speed is measured for auto-pause
    autoPause: true,
    pauseSpeed: 0.6,       // m/s; below this for pauseAfter -> paused
    resumeSpeed: 1.2,      // m/s; above this for resumeAfter -> moving (hysteresis band)
    pauseAfter: 5000,      // ms
    resumeAfter: 3000,     // ms
    gapPause: 60000,       // ms; a gap this long between fixes is not counted as moving
    splitDistance: 1000,   // m
    paceDistance: 400,     // m used for "current pace"
    maxPoints: 200000      // stored track points; beyond this the track is decimated
  };

  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function own(o, k) { return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k); }

  function settings(opts) {
    var s = {};
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
      var v = own(opts, k) ? opts[k] : DEFAULTS[k];
      if (k === "sport") s[k] = Object.prototype.hasOwnProperty.call(SPORT_MAX_SPEED, v) ? v : "other";
      else if (k === "autoPause") s[k] = v !== false;
      else if (k === "maxSpeed") s[k] = typeof v === "number" && v > 0 && isFinite(v) ? v : null;
      else s[k] = typeof v === "number" && isFinite(v) && v >= 0 ? v : DEFAULTS[k];
    }
    if (s.maxSpeed === null) s.maxSpeed = SPORT_MAX_SPEED[s.sport];
    if (s.resumeSpeed < s.pauseSpeed) s.resumeSpeed = s.pauseSpeed;
    s.smoothN = Math.max(1, Math.min(20, Math.floor(s.smoothN)));
    return s;
  }

  function createRecorder(opts) {
    return {
      s: settings(opts),
      startT: null, lastT: null,
      last: null,          // last accepted raw fix
      spikes: [],          // consecutive spike-rejected fixes
      recent: [],          // last smoothN accepted fixes (for smoothing)
      speedBuf: [],        // smoothed positions in the speed window
      anchor: null,        // smoothed position distance is measured from
      distance: 0, movingTime: 0, mtAtStep: 0,
      paused: false, manualPause: false,
      candSince: null,     // time the pause/resume condition began
      candAnchor: null,    // smoothed position when a resume candidate began
      laps: [], lapStart: { t: null, distance: 0, movingTime: 0 },
      splits: [], nextSplit: 0,
      hist: [],            // [movingTime, distance] samples for pace
      track: [], decimate: 1, accepted: 0, rejected: { accuracy: 0, spike: 0, invalid: 0, time: 0 }
    };
  }

  function validFix(f) {
    return f && typeof f === "object" && typeof f.lat === "number" && typeof f.lon === "number" && typeof f.t === "number" &&
      isFinite(f.lat) && isFinite(f.lon) && isFinite(f.t) && f.lat >= -90 && f.lat <= 90 && f.lon >= -180 && f.lon <= 180;
  }

  function smoothed(st) {
    var la = 0, lo = 0, n = st.recent.length;
    for (var i = 0; i < n; i++) { la += st.recent[i].lat; lo += st.recent[i].lon; }
    return { lat: la / n, lon: lo / n };
  }

  // Net displacement of the smoothed position over the window. Summing hop
  // lengths instead would turn standing-still jitter into walking speed.
  function windowSpeed(st) {
    var b = st.speedBuf;
    if (b.length < 2) return null;
    var dt = (b[b.length - 1].t - b[0].t) / 1000;
    if (dt <= 0) return null;
    return haversine(b[0], b[b.length - 1]) / dt;
  }

  function isPaused(st) { return st.paused || st.manualPause; }

  function pushHist(st) {
    var h = st.hist, last = h[h.length - 1];
    if (!last || st.distance - last[1] >= 5 || st.movingTime - last[0] >= 5000) h.push([st.movingTime, st.distance]);
    // Keep only what pace needs (plus a margin), so memory stays bounded.
    while (h.length > 2 && st.distance - h[1][1] > st.s.paceDistance * 2) h.shift();
  }

  function storePoint(st, f) {
    if (st.accepted % st.decimate !== 0) return;
    st.track.push({ t: f.t, lat: f.lat, lon: f.lon, ele: typeof f.alt === "number" && isFinite(f.alt) ? f.alt : null, acc: f.acc, paused: isPaused(st) });
    if (st.track.length > st.s.maxPoints) {
      var keep = [];
      for (var i = 0; i < st.track.length; i += 2) keep.push(st.track[i]);
      st.track = keep; st.decimate *= 2;
    }
  }

  // Feed one fix: { t (ms), lat, lon, acc (m, optional), alt (optional) }.
  // Returns { accepted, reason, state } where state is the live view.
  function addFix(st, f) {
    var s = st.s;
    if (!validFix(f)) { st.rejected.invalid++; return { accepted: false, reason: "invalid", state: view(st) }; }
    var acc = typeof f.acc === "number" && isFinite(f.acc) ? f.acc : null;
    if (acc !== null && (acc > s.maxAccuracy || acc < 0)) { st.rejected.accuracy++; return { accepted: false, reason: "accuracy", state: view(st) }; }
    if (st.lastT !== null && f.t <= st.lastT) { st.rejected.time++; return { accepted: false, reason: "time", state: view(st) }; }
    var fix = { t: f.t, lat: f.lat, lon: f.lon, acc: acc, alt: f.alt };

    if (st.last) {
      var dt = (fix.t - st.last.t) / 1000;
      var v = haversine(st.last, fix) / dt;
      // Allow for the stated accuracy of both fixes before calling it a spike.
      var slack = ((acc || 0) + (st.last.acc || 0)) / dt;
      if (v > s.maxSpeed + slack) {
        st.spikes.push(fix);
        var reseed = false;
        if (st.spikes.length >= s.spikeReseed) {
          reseed = true;
          for (var i = 1; i < st.spikes.length; i++) {
            var a = st.spikes[i - 1], b = st.spikes[i];
            if (haversine(a, b) / ((b.t - a.t) / 1000) > s.maxSpeed) { reseed = false; break; }
          }
          if (!reseed) st.spikes.shift();
        }
        if (!reseed) { st.rejected.spike++; return { accepted: false, reason: "spike", state: view(st) }; }
        // The old anchor was the outlier: restart smoothing from the new cluster
        // without counting the jump.
        var cluster = st.spikes; st.spikes = [];
        st.recent = []; st.speedBuf = [];
        st.last = null; st.anchor = null;
        for (var c = 0; c < cluster.length - 1; c++) st.recent.push(cluster[c]);
        st.last = cluster[cluster.length - 2];
        fix = cluster[cluster.length - 1];
        st.anchor = smoothed(st);
      }
    }
    st.spikes = [];

    if (st.startT === null) { st.startT = fix.t; st.lapStart.t = fix.t; }
    var prevT = st.lastT;
    st.lastT = fix.t; st.last = fix; st.accepted++;

    st.recent.push(fix); if (st.recent.length > s.smoothN) st.recent.shift();
    var sm = smoothed(st);
    st.speedBuf.push({ t: fix.t, lat: sm.lat, lon: sm.lon });
    while (st.speedBuf.length > 2 && fix.t - st.speedBuf[1].t >= s.speedWindow) st.speedBuf.shift();
    var speed = windowSpeed(st);
    var spanOk = st.speedBuf.length >= 2 && fix.t - st.speedBuf[0].t >= Math.min(s.speedWindow, 2000);

    // Auto-pause state machine with hysteresis (separate pause/resume speeds
    // and dwell times).
    if (s.autoPause && speed !== null && spanOk && !st.manualPause) {
      if (!st.paused) {
        if (speed < s.pauseSpeed) {
          if (st.candSince === null) st.candSince = fix.t;
          if (fix.t - st.candSince >= s.pauseAfter) {
            // The dwell before the pause took effect was not really moving.
            if (prevT !== null) st.movingTime = Math.max(0, st.movingTime - Math.max(0, prevT - st.candSince));
            st.paused = true; st.candSince = null;
          }
        } else st.candSince = null;
      } else {
        if (speed > s.resumeSpeed) {
          if (st.candSince === null) { st.candSince = fix.t; st.candAnchor = st.anchor; }
          if (fix.t - st.candSince >= s.resumeAfter) {
            // Count the time and movement made while confirming the resume.
            if (prevT !== null) st.movingTime += Math.max(0, prevT - st.candSince);
            st.paused = false; st.candSince = null;
            if (st.candAnchor) st.anchor = st.candAnchor;
          }
        } else { st.candSince = null; st.anchor = sm; }
      }
    }

    if (prevT !== null && !isPaused(st)) {
      var gap = fix.t - prevT;
      if (gap < s.gapPause) st.movingTime += gap;
    }

    if (!st.anchor) st.anchor = sm;
    if (!isPaused(st)) {
      var step = haversine(st.anchor, sm);
      if (step >= s.minStep) {
        var before = st.distance, mtBefore = st.mtAtStep;
        st.distance += step;
        st.mtAtStep = st.movingTime;
        st.anchor = sm;
        // Live splits, with time interpolated to the exact split distance.
        while (st.distance >= st.nextSplit + s.splitDistance && s.splitDistance > 0) {
          var target = st.nextSplit + s.splitDistance;
          var frac = st.distance > before ? (target - before) / (st.distance - before) : 1;
          var tAt = mtBefore + (st.movingTime - mtBefore) * frac;
          var prevSplitT = st.splits.length ? st.splits[st.splits.length - 1].movingTimeAt : 0;
          st.splits.push({ index: st.splits.length + 1, distance: target, movingTimeAt: tAt, time: tAt - prevSplitT });
          st.nextSplit = target;
        }
      }
    } else if (!st.candSince) {
      st.anchor = sm; // drift while paused is not distance
    }
    pushHist(st);
    storePoint(st, fix);
    return { accepted: true, reason: null, state: view(st) };
  }

  function setManualPause(st, on) { st.manualPause = !!on; if (on) st.candSince = null; if (!on && st.recent.length) st.anchor = smoothed(st); return view(st); }

  // Close the current lap at the last accepted fix.
  function lap(st) {
    var L = st.lapStart;
    var item = {
      index: st.laps.length + 1,
      startT: L.t, endT: st.lastT,
      distance: st.distance - L.distance,
      movingTime: st.movingTime - L.movingTime,
      elapsed: L.t === null || st.lastT === null ? 0 : st.lastT - L.t
    };
    item.pace = item.distance >= 10 ? item.movingTime / 1000 / (item.distance / 1000) : null;
    st.laps.push(item);
    st.lapStart = { t: st.lastT, distance: st.distance, movingTime: st.movingTime };
    return item;
  }

  // Seconds per km over the last paceDistance metres of moving time.
  function currentPace(st) {
    var h = st.hist;
    if (st.distance < Math.min(50, st.s.paceDistance)) return null;
    var targetD = st.distance - st.s.paceDistance, i = h.length - 1;
    while (i > 0 && h[i - 1][1] > targetD) i--;
    var j = Math.max(0, i - 1);
    var d0 = h[j][1], t0 = h[j][0];
    if (h[j][1] <= targetD && i < h.length && h[i][1] > h[j][1]) {
      var f = (targetD - h[j][1]) / (h[i][1] - h[j][1]);
      d0 = targetD; t0 = h[j][0] + (h[i][0] - h[j][0]) * f;
    }
    var dd = st.distance - d0, dt = st.movingTime - t0;
    if (dd < 10 || dt <= 0) return null;
    return (dt / 1000) / (dd / 1000);
  }

  function view(st) {
    return {
      distance: st.distance,
      movingTime: st.movingTime,
      elapsed: st.startT === null ? 0 : st.lastT - st.startT,
      paused: isPaused(st), autoPaused: st.paused, manualPause: st.manualPause,
      pace: currentPace(st),
      avgPace: st.distance >= 10 ? (st.movingTime / 1000) / (st.distance / 1000) : null,
      splits: st.splits.length, laps: st.laps.length, points: st.track.length
    };
  }

  function summary(st) {
    var v = view(st);
    v.splitList = st.splits.slice();
    v.lapList = st.laps.slice();
    v.rejected = { accuracy: st.rejected.accuracy, spike: st.rejected.spike, invalid: st.rejected.invalid, time: st.rejected.time };
    v.accepted = st.accepted;
    v.startT = st.startT; v.endT = st.lastT;
    v.track = st.track.slice();
    return v;
  }

  // Batch helper: run a whole list of fixes through a fresh recorder.
  function processTrack(fixes, opts) {
    if (!Array.isArray(fixes)) throw err("input", "Fixes must be an array.");
    var st = createRecorder(opts);
    for (var i = 0; i < fixes.length; i++) addFix(st, fixes[i]);
    return summary(st);
  }

  return Object.freeze({
    DEFAULTS: Object.freeze(Object.assign({}, DEFAULTS)),
    haversine: haversine,
    createRecorder: createRecorder,
    addFix: addFix,
    setManualPause: setManualPause,
    lap: lap,
    currentPace: currentPace,
    view: view,
    summary: summary,
    processTrack: processTrack
  });
})();
