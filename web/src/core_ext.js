// Pulse core, part 2: physiology, strength, logs, whole-day measures, routes and migration
// imports. Pure functions; mirrors src/pulse/{physio,strength,logs,daily,routes,imports}.py.
Object.assign(SB, (() => {
  const { err, num, mean, sd, haversine, projectLocal, parseDay, daysFromCivil, civilFromDays, dayStr, bisectLeft, cmp, blankDay, mulberry32 } = SB;

  // ------------------------------------------------------------------ physio
  function keytelKcalPerMin(hr, w, age, sex) {
    const kj = sex === "female" ? -20.4022 + 0.4472 * hr - 0.1263 * w + 0.074 * age
      : -55.0969 + 0.6309 * hr + 0.1988 * w + 0.2017 * age;
    return Math.max(0.0, kj / 4.184);
  }
  const RUN_MET = [[4.0, 6.0], [5.0, 8.3], [5.2, 9.0], [6.0, 9.8], [6.7, 10.5], [7.0, 11.0], [7.5, 11.5], [8.0, 11.8],
    [8.6, 12.3], [9.0, 12.8], [10.0, 14.5], [11.0, 16.0], [12.0, 19.0], [13.0, 19.8], [14.0, 23.0]];
  const RIDE_MET = [[0.0, 4.0], [10.0, 6.8], [12.0, 8.0], [14.0, 10.0], [16.0, 12.0], [20.0, 15.8]];
  function metFor(sport, speed) {
    const mph = (speed || 0) * 2.2369362920544;
    if (sport === "run") {
      if (mph < RUN_MET[0][0]) return 3.5;
      for (let k = 1; k < RUN_MET.length; k++) {
        if (mph <= RUN_MET[k][0]) {
          const [x0, y0] = RUN_MET[k - 1], [x1, y1] = RUN_MET[k];
          return y0 + (mph - x0) / (x1 - x0) * (y1 - y0);
        }
      }
      return RUN_MET[RUN_MET.length - 1][1];
    }
    if (sport === "ride") { let m = RIDE_MET[0][1]; for (const [lo, v] of RIDE_MET) if (mph >= lo) m = v; return m; }
    if (sport === "strength") return 3.5;
    return 5.0;
  }
  function calories(t, hr, sport, movingS, speed, s) {
    let kcal = 0, covered = 0;
    for (let i = 1; i < t.length; i++) {
      const dt = t[i] - t[i - 1], h = i - 1 < hr.length ? hr[i - 1] : null;
      if (h === null || dt <= 0 || dt > s.hr_gap) continue;
      kcal += keytelKcalPerMin(h, s.weight_kg, s.age, s.trimp_sex) * dt / 60.0;
      covered += dt;
    }
    if (movingS > 0 && covered >= 0.5 * movingS) return { kcal, method: "keytel" };
    const met = metFor(sport, speed);
    return { kcal: met * s.weight_kg * movingS / 3600.0, method: "met", met };
  }
  function vo2maxUth(maxHr, restHr) { if (!restHr || restHr <= 0 || !maxHr) return null; return 15.3 * maxHr / restHr; }
  function vdot(distance, time) {
    if (!distance || !time || time <= 0) return null;
    const tmin = time / 60.0, v = distance / tmin;
    const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v;
    const pct = 0.8 + 0.1894393 * Math.exp(-0.012778 * tmin) + 0.2989558 * Math.exp(-0.1932605 * tmin);
    return vo2 / pct;
  }
  function riegel(time, d1, d2, e) { return time * Math.pow(d2 / d1, e === undefined ? 1.06 : e); }
  const RACES = [["5 km", 5000.0], ["10 km", 10000.0], ["Half marathon", 21097.5], ["Marathon", 42195.0]];
  function bestVdot(efforts) {
    let best = null;
    for (const [d, tm] of efforts) {
      if (d === null || tm === null || d < 1609.0) continue;
      const v = vdot(d, tm);
      if (v !== null && (best === null || v > best.vdot)) best = { vdot: v, distance: d, time: tm };
    }
    if (best === null) return null;
    best.predictions = RACES.map(([label, D]) => ({ label, distance: D, time: riegel(best.time, best.distance, D) }));
    return best;
  }
  const NORM_AGES = [25.0, 35.0, 45.0, 55.0, 65.0, 75.0, 85.0];
  const NORM_MEN = [46.5, 39.7, 35.3, 29.2, 24.6, 20.6, 17.6];
  const NORM_WOMEN = [36.6, 28.3, 25.7, 22.9, 19.6, 17.2, 15.4];
  function fitnessAge(vo2, sex) {
    if (vo2 === null || vo2 === undefined) return null;
    const norm = sex === "female" ? NORM_WOMEN : NORM_MEN;
    if (vo2 >= norm[0]) return Math.max(20.0, NORM_AGES[0] - (vo2 - norm[0]) / (norm[0] - norm[1]) * 10.0);
    for (let k = 1; k < norm.length; k++) {
      if (vo2 >= norm[k]) { const f = (norm[k - 1] - vo2) / (norm[k - 1] - norm[k]); return NORM_AGES[k - 1] + f * 10.0; }
    }
    const L = norm.length;
    return Math.min(90.0, NORM_AGES[L - 1] + (norm[L - 1] - vo2) / (norm[L - 2] - norm[L - 1]) * 10.0);
  }
  const POWER_ZONES = [0.55, 0.75, 0.90, 1.05, 1.20, 1.50];
  const PACE_ZONES = [0.78, 0.88, 0.95, 1.00, 1.04];
  function powerZoneTime(t, pwr, ftp, s) {
    let c = 0;
    for (const p of pwr) if (p !== null) c++;
    if (!ftp || c < 2) return null;
    const out = [0, 0, 0, 0, 0, 0, 0], t0 = t[0], T = Math.floor(t[t.length - 1] - t0), n = t.length;
    let k = 0;
    for (let sec = 0; sec <= T; sec++) {
      while (k + 1 < n && t[k + 1] - t0 <= sec) k++;
      const p = pwr[k];
      const v = p !== null && sec - (t[k] - t0) <= s.hr_gap ? p : 0;
      let z = 0;
      for (const b of POWER_ZONES) if (v >= b * ftp) z++;
      out[z] += 1;
    }
    return out;
  }
  function paceZoneTime(t, d, mov, thr) {
    if (!thr) return null;
    const out = [0, 0, 0, 0, 0, 0];
    for (let i = 1; i < t.length; i++) {
      if (!mov[i]) continue;
      const dt = t[i] - t[i - 1], v = (d[i] - d[i - 1]) / dt;
      let z = 0;
      for (const b of PACE_ZONES) if (v >= b * thr) z++;
      out[z] += dt;
    }
    return out;
  }
  function luciaTrimp(t, hr, vt1, vt2, s) {
    if (!vt1 || !vt2) return null;
    let tot = 0, seen = false;
    for (let i = 1; i < t.length; i++) {
      const dt = t[i] - t[i - 1], h = hr[i - 1];
      if (h === null || dt <= 0 || dt > s.hr_gap) continue;
      seen = true;
      tot += dt / 60.0 * (h < vt1 ? 1 : (h < vt2 ? 2 : 3));
    }
    return seen ? tot : null;
  }
  function powerLoad(weighted, seconds, ftp) {
    if (!weighted || !ftp || seconds <= 0) return null;
    const rel = weighted / ftp;
    return seconds / 3600.0 * rel * rel * 100.0;
  }
  function powerHrRatio(pairs, minimum) {
    minimum = minimum === undefined ? 10 : minimum;
    const ps = pairs.filter(([p, h]) => p !== null && h !== null && h > 0);
    if (ps.length < minimum) return null;
    let nu = 0, de = 0;
    for (const [p, h] of ps) { nu += p * h; de += h * h; }
    return de > 0 ? nu / de : null;
  }
  function dayIndex(T) {
    if (T === null || T === undefined || T <= 0) return 0.0;
    return Math.min(10.0, 10.0 * Math.log(1.0 + T / 25.0) / Math.log(1.0 + 1000.0 / 25.0));
  }
  function summaryTrimp(avgHr, minutes, s) {
    if (avgHr === null || avgHr === undefined || !minutes) return null;
    const [a, b] = s.trimp_sex === "female" ? [0.86, 1.67] : [0.64, 1.92];
    let x = (avgHr - s.rest_hr) / (s.max_hr - s.rest_hr);
    x = x < 0 ? 0 : (x > 1 ? 1 : x);
    return minutes * x * a * Math.exp(b * x);
  }

  // ------------------------------------------------------------------ strength
  function epley(load, reps) { if (load === null || load === undefined || !reps || reps < 1) return null; return reps === 1 ? load : load * (1.0 + reps / 30.0); }
  function brzycki(load, reps) { if (load === null || load === undefined || !reps || reps < 1 || reps >= 37) return null; return load * 36.0 / (37.0 - reps); }
  function sessionStats(ses) {
    let vol = 0;
    const per = {};
    for (const st of ses.sets || []) {
      const ex = (st.exercise || "").trim(), reps = st.reps || 0, load = st.load || 0;
      if (!ex || reps <= 0) continue;
      const v = reps * load;
      vol += v;
      if (!per[ex]) per[ex] = { sets: 0, reps: 0, volume: 0, top_load: 0, e1rm: 0, brzycki: 0 };
      const e = per[ex];
      e.sets += 1; e.reps += reps; e.volume += v;
      e.top_load = Math.max(e.top_load, load);
      e.e1rm = Math.max(e.e1rm, epley(load, reps) || 0);
      e.brzycki = Math.max(e.brzycki, brzycki(load, reps) || 0);
    }
    return { volume: vol, exercises: per };
  }
  function strengthRecords(sessions) {
    const out = {};
    const ss = sessions.slice().sort((a, b) => a.date - b.date);
    for (const ses of ss) {
      for (const st of ses.sets || []) {
        const ex = (st.exercise || "").trim(), reps = st.reps || 0, load = st.load || 0;
        if (!ex || reps <= 0) continue;
        if (!out[ex]) out[ex] = { e1rm: 0, e1rm_date: null, load: 0, load_date: null, set_volume: 0, set_volume_date: null, trend: [] };
        const r = out[ex], e = epley(load, reps) || 0;
        if (e > r.e1rm) { r.e1rm = e; r.e1rm_date = ses.date; }
        if (load > r.load) { r.load = load; r.load_date = ses.date; }
        if (reps * load > r.set_volume) { r.set_volume = reps * load; r.set_volume_date = ses.date; }
      }
      const ex2 = sessionStats(ses).exercises;
      for (const ex of Object.keys(ex2)) out[ex].trend.push([ses.date, ex2[ex].e1rm]);
    }
    return out;
  }

  // ------------------------------------------------------------------ logs
  const weekStart = (z) => z - (((z + 3) % 7) + 7) % 7;
  function periodRange(period, z) {
    if (period === "week") { const a = weekStart(z); return [a, a + 6]; }
    const [y, m] = civilFromDays(z);
    if (period === "month") return [daysFromCivil(y, m, 1), daysFromCivil(y + (m === 12 ? 1 : 0), m === 12 ? 1 : m + 1, 1) - 1];
    return [daysFromCivil(y, 1, 1), daysFromCivil(y + 1, 1, 1) - 1];
  }
  function valueOf(r, metric) {
    if (metric === "distance") return r.distance || 0;
    if (metric === "time") return r.moving || 0;
    if (metric === "elevation") return r.gain || 0;
    return 1.0;
  }
  function totals(rows, a, b, sport) {
    sport = sport || "all";
    const out = { count: 0, distance: 0, moving: 0, elevation: 0, load: 0, kcal: 0, by_sport: {} };
    for (const r of rows) {
      if (!(a <= r.day && r.day <= b) || (sport !== "all" && r.sport !== sport)) continue;
      out.count++; out.distance += r.distance || 0; out.moving += r.moving || 0; out.elevation += r.gain || 0;
      out.load += r.load || 0; out.kcal += r.kcal || 0;
      if (!out.by_sport[r.sport]) out.by_sport[r.sport] = { count: 0, distance: 0, moving: 0 };
      const bs = out.by_sport[r.sport];
      bs.count++; bs.distance += r.distance || 0; bs.moving += r.moving || 0;
    }
    return out;
  }
  function goalProgress(rows, goal, day) {
    const [a, b] = periodRange(goal.period, day), sport = goal.sport || "all";
    let v = 0;
    for (const r of rows) if (a <= r.day && r.day <= b && (sport === "all" || r.sport === sport)) v += valueOf(r, goal.metric);
    const target = goal.target, elapsed = (day - a + 1) / (b - a + 1), frac = target ? v / target : null;
    return { start: a, end: b, value: v, target, fraction: frac, elapsed, on_pace: frac !== null && frac >= elapsed, days_left: b - day };
  }
  function periods(rows, period, endDay, count) {
    const out = [];
    let z = endDay;
    for (let k = 0; k < count; k++) {
      const [a, b] = periodRange(period, z), t = totals(rows, a, b);
      t.start = a; t.end = b; out.push(t); z = a - 1;
    }
    return out.reverse();
  }
  function weeklyBand(rows, day) {
    const a = weekStart(day), cur = totals(rows, a, a + 6).load;
    const prev = [1, 2, 3, 4].map((k) => totals(rows, a - 7 * k, a - 7 * k + 6).load);
    const mu = mean(prev), sig = sd(prev) || 0;
    return { week: cur, mean: mu, sd: sig, lo: Math.max(0, mu - sig), hi: mu + sig, previous: prev };
  }
  function longestStreak(days) {
    let best = 0, run = 0, prev = null;
    for (const z of Array.from(new Set(days)).sort((a, b) => a - b)) {
      run = prev !== null && z === prev + 1 ? run + 1 : 1;
      best = Math.max(best, run); prev = z;
    }
    return best;
  }
  function yearReview(rows, year) {
    const a = daysFromCivil(year, 1, 1), b = daysFromCivil(year + 1, 1, 1) - 1;
    const yr = rows.filter((r) => a <= r.day && r.day <= b);
    const t = totals(rows, a, b);
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const ma = daysFromCivil(year, m, 1), mb = daysFromCivil(year + (m === 12 ? 1 : 0), m === 12 ? 1 : m + 1, 1) - 1;
      months.push(totals(rows, ma, mb).distance);
    }
    const weekdays = [0, 0, 0, 0, 0, 0, 0];
    for (const r of yr) weekdays[(r.day + 3) % 7]++;
    const best = {};
    for (const r of yr) for (const [dist, tm] of r.fastest || []) {
      const key = String(dist);
      if (tm !== null && (!(key in best) || tm < best[key][0])) best[key] = [tm, r.id];
    }
    const pick = (f) => {
      let o = null;
      for (const r of yr) { if (o === null || f(r) > f(o) || (f(r) === f(o) && r.day < o.day)) o = r; }
      return o;
    };
    const longest = pick((r) => r.distance || 0), climb = pick((r) => r.gain || 0);
    let top = null;
    if (yr.length) { top = 0; for (let k = 1; k < 12; k++) if (months[k] > months[top]) top = k; top += 1; }
    return { year, totals: t, months, active_days: new Set(yr.map((r) => r.day)).size, streak: longestStreak(yr.map((r) => r.day)),
      weekdays, longest: longest ? longest.id : null, biggest_climb: climb ? climb.id : null, best, top_month: top };
  }
  function gearTotals(gear, rows) {
    return gear.map((g) => {
      let dist = (g.start_km || 0) * 1000.0, mov = 0, n = 0;
      for (const r of rows) if (r.gear === g.id) { dist += r.distance || 0; mov += r.moving || 0; n++; }
      const lim = g.retire_km;
      return { id: g.id, distance: dist, moving: mov, count: n, retire: !!lim && dist >= lim * 1000.0, remaining: lim ? lim * 1000.0 - dist : null };
    });
  }
  function weightTrend(entries, window) {
    window = window || 7;
    const es = entries.filter((e) => e.kg).sort((a, b) => a.date - b.date);
    const out = es.map((e) => {
      const vals = es.filter((x) => e.date - window < x.date && x.date <= e.date).map((x) => x.kg);
      return [e.date, e.kg, SB.sum(vals) / vals.length];
    });
    let change = null;
    if (out.length) {
      const last = out[out.length - 1], earlier = out.filter((o) => o[0] <= last[0] - 30);
      if (earlier.length) change = last[2] - earlier[earlier.length - 1][2];
    }
    return { series: out, change30: change };
  }
  function bpSummary(entries, day) {
    const avg = (days) => {
      const sel = entries.filter((e) => day - days < e.date && e.date <= day && e.sys && e.dia);
      if (!sel.length) return null;
      return [SB.sum(sel.map((e) => e.sys)) / sel.length, SB.sum(sel.map((e) => e.dia)) / sel.length, sel.length];
    };
    return { d7: avg(7), d30: avg(30) };
  }
  function cyclePhase(starts, day, defaultLen) {
    defaultLen = defaultLen || 28;
    const past = starts.filter((z) => z <= day).sort((a, b) => a - b);
    if (!past.length) return null;
    let gaps = [];
    for (let k = 1; k < past.length; k++) { const g = past[k] - past[k - 1]; if (g >= 21 && g <= 45) gaps.push(g); }
    gaps = gaps.slice(-6);
    const length = gaps.length ? SB.sum(gaps) / gaps.length : defaultLen;
    const start = past[past.length - 1], cd = day - start + 1, ov = length - 14.0;
    let phase;
    if (cd <= 5) phase = "menstrual";
    else if (cd > length + 7) phase = "unknown";
    else if (cd < ov - 1) phase = "follicular";
    else if (cd <= ov + 1) phase = "ovulatory";
    else phase = "luteal";
    return { cycle_day: cd, length, phase, next_start: start + Math.floor(length + 0.5) };
  }
  function association(answers, metric, day, tag, window, perms, seed) {
    window = window || 90; perms = perms === undefined ? 2000 : perms; seed = seed === undefined ? 12345 : seed;
    const g = (m, z) => (m instanceof Map ? m.get(z) : m[z]);
    const yes = [], no = [];
    for (let z = day - window + 1; z <= day; z++) {
      const a = g(answers, z), mv = g(metric, z + 1);
      if (a === undefined || a === null || !(tag in a) || mv === undefined || mv === null) continue;
      (a[tag] ? yes : no).push(mv);
    }
    const out = { tag, n_yes: yes.length, n_no: no.length, diff: null, d: null, p: null };
    if (yes.length < 5 || no.length < 5) return out;
    const diff = mean(yes) - mean(no), s1 = sd(yes), s2 = sd(no);
    const pooled = Math.sqrt(((yes.length - 1) * s1 * s1 + (no.length - 1) * s2 * s2) / (yes.length + no.length - 2));
    const all = yes.concat(no), rnd = mulberry32(seed), ny = yes.length;
    let hits = 0;
    for (let k = 0; k < perms; k++) {
      const v = all.slice();
      for (let i = v.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = v[i]; v[i] = v[j]; v[j] = tmp; }
      let s1_ = 0, s2_ = 0;
      for (let i = 0; i < ny; i++) s1_ += v[i];
      for (let i = ny; i < v.length; i++) s2_ += v[i];
      const dd = s1_ / ny - s2_ / (v.length - ny);
      if (Math.abs(dd) >= Math.abs(diff) - 1e-12) hits++;
    }
    out.diff = diff; out.d = pooled > 0 ? diff / pooled : null; out.p = (hits + 1) / (perms + 1);
    return out;
  }
  const pct = (a, b) => (b ? (a / b - 1.0) * 100.0 : null);
  const f0 = (x) => fmtFixed(x, 0), f1 = (x) => fmtFixed(x, 1);
  // Python's format rounds exact binary ties half to even; toFixed rounds them up. Real readouts
  // are never exact ties, so the two agree.
  function fmtFixed(x, k) { return x.toFixed(k); }
  function insights(rows, ready, series, day, sleepRows) {
    const out = [];
    const h = ready ? ready.hrv : null;
    if (h && h.roll !== null && h.roll !== undefined) {
      const roll = Math.exp(h.roll), base = Math.exp(h.mean), p = pct(roll, base);
      out.push({ key: "hrv", text: "HRV 7-day mean is " + f0(Math.abs(p)) + "% " + (p < 0 ? "below" : "above") + " your 60-day baseline.",
        numbers: { week_ms: roll, baseline_ms: base, pct: p } });
    }
    const k = ready ? ready.rhr : null;
    if (k && k.recent !== null && k.recent !== undefined) {
      const dl = k.recent - k.mean;
      out.push({ key: "rhr", text: "Resting HR is " + f1(Math.abs(dl)) + " bpm " + (dl > 0 ? "above" : "below") + " your baseline.",
        numbers: { recent: k.recent, baseline: k.mean, diff: dl } });
    }
    const wb = weeklyBand(rows, day);
    if (wb.mean) {
      const p = pct(wb.week, wb.mean);
      out.push({ key: "load", text: "This week's load is " + f0(Math.abs(p)) + "% " + (p > 0 ? "above" : "below") + " your 4-week average.",
        numbers: { week: wb.week, average: wb.mean, pct: p } });
    }
    const a = weekStart(day), thisW = totals(rows, a, a + 6).distance, lastW = totals(rows, a - 7, a - 1).distance;
    if (lastW > 0) {
      out.push({ key: "distance", text: "Distance so far this week is " + f1(thisW / 1000) + " km against " + f1(lastW / 1000) + " km last week.",
        numbers: { this_week_m: thisW, last_week_m: lastW, pct: pct(thisW, lastW) } });
    }
    if (sleepRows && sleepRows.length) {
      const nights = sleepRows.filter((r) => day - 7 < r.date && r.date <= day && r.sleep !== null && r.sleep !== undefined).map((r) => r.sleep);
      if (nights.length >= 3) {
        const m = SB.sum(nights) / nights.length;
        out.push({ key: "sleep", text: "Average sleep over the last " + nights.length + " nights is " + f1(m) + " h.", numbers: { mean_h: m, nights: nights.length } });
      }
    }
    if (series && series.form && series.form.length) {
      const L = series.form.length, fit = series.fitness[L - 1], fo = series.form[L - 1], fa = series.fatigue[L - 1];
      out.push({ key: "form", text: "Form is " + f0(fo) + " (fitness " + f0(fit) + ", fatigue " + f0(fa) + ").", numbers: { form: fo, fitness: fit, fatigue: fa } });
    }
    return out;
  }
  const SESSIONS = {
    "run|Recover": "Rest, or 20 to 30 min very easy running in zone 1 to 2.",
    "run|Maintain": "40 to 60 min steady running in zone 2.",
    "run|Build": "Warm up 15 min, 5 x 4 min in zone 4 with 3 min easy between, cool down 10 min.",
    "ride|Recover": "Rest, or 30 to 45 min easy spinning in zone 1.",
    "ride|Maintain": "60 to 90 min steady riding in zone 2.",
    "ride|Build": "Warm up 15 min, 3 x 10 min in zone 4 with 5 min easy between, cool down 10 min.",
    "other|Recover": "Rest or gentle mobility for 20 min.",
    "other|Maintain": "45 min of steady, conversational effort.",
    "other|Build": "A harder session: 30 min with several 3 to 5 min efforts in zone 4.",
  };
  const READY_WHY = { clear: "no readiness input is off its baseline", one_off: "one readiness input is off its baseline",
    several_off: "two or more readiness inputs are off their baselines" };
  function suggest(rows, ready, series, day) {
    const recent = rows.filter((r) => day - 28 < r.day && r.day <= day).map((r) => r.sport);
    let sport = "run";
    if (recent.length) {
      let bestN = -1;
      for (const sp of Array.from(new Set(recent)).sort(cmp)) {
        const c = recent.filter((x) => x === sp).length;
        if (c > bestN) { bestN = c; sport = sp; }
      }
    }
    if (sport !== "run" && sport !== "ride") sport = "other";
    const state = (ready || {}).state || "none";
    const L = series && series.fitness ? series.fitness.length : 0;
    const fit = L ? series.fitness[L - 1] : 0, form = L ? series.form[L - 1] : 0;
    const rel = fit > 0 ? form / fit : 0;
    let intent;
    if (state === "several_off" || (fit > 0 && rel < -0.3)) intent = "Recover";
    else if (state === "one_off" || (fit > 0 && rel < -0.1)) intent = "Maintain";
    else intent = "Build";
    const why = [];
    if (state !== "none") why.push(READY_WHY[state]);
    if (fit > 0) why.push("form is " + f0(form) + " against fitness " + f0(fit) + " (" + f0(rel * 100) + "%)");
    const reason = why.length ? "Because " + why.join(" and ") + "." : "No readiness or load data yet; a steady session is the safe default.";
    return { intent, sport, session: SESSIONS[sport + "|" + intent], reason, numbers: { state, form, fitness: fit, ratio: rel } };
  }

  // ------------------------------------------------------------------ daily
  const localDayOf = (m, off) => Math.floor((m * 60 + off) / 86400);
  function efficiency(row) { if (row.sleep === null || row.sleep === undefined || !row.in_bed) return null; return Math.min(1.0, row.sleep / row.in_bed); }
  function consistency(rows, day, nights) {
    nights = nights || 4;
    const sel = rows.filter((r) => day - nights < r.date && r.date <= day && r.bed_min !== null && r.bed_min !== undefined && r.wake_min !== null && r.wake_min !== undefined);
    if (sel.length < 3) return null;
    const sb = sd(sel.map((r) => r.bed_min)), sw = sd(sel.map((r) => r.wake_min));
    return { nights: sel.length, sd_bed: sb, sd_wake: sw, score: 100.0 * Math.max(0.0, 1.0 - (sb + sw) / 120.0) };
  }
  function median(xs) {
    const v = xs.slice().sort((a, b) => a - b), n = v.length;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2.0;
  }
  function vital(rows, day, key, baseDays, minBase) {
    baseDays = baseDays || 60; minBase = minBase || 14;
    const by = new Map();
    for (const r of rows) by.set(r.date, r);
    const cr = by.get(day), cur = cr ? cr[key] : null;
    const base = [];
    for (let z = day - baseDays; z < day; z++) { const r = by.get(z); if (r && r[key] !== null && r[key] !== undefined) base.push(r[key]); }
    if (cur === null || cur === undefined || base.length < minBase) return null;
    const med = median(base), dev = base.map((x) => Math.abs(x - med));
    let rsd = 1.4826 * median(dev);
    if (!(rsd > 0)) rsd = 1.253314 * dev.reduce((a, b) => a + b, 0) / dev.length; // MAD of 0: modified z-score fallback
    // every baseline value the same: there is no spread to compare with (not "z = 0")
    if (!(rsd > 0)) return { value: cur, median: med, rsd: 0.0, z: null, flag: false, no_variation: true };
    const z = (cur - med) / rsd;
    return { value: cur, median: med, rsd, z, flag: Math.abs(z) > 2.0, no_variation: false };
  }
  function overnightRhr(hr, a, b) {
    const sel = hr.filter(([m]) => a <= m * 60 && m * 60 < b);
    let best = null;
    for (let k = 0; k + 4 < sel.length; k++) {
      if (sel[k + 4][0] - sel[k][0] !== 4) continue;
      let s = 0;
      for (let q = k; q < k + 5; q++) s += sel[q][1];
      const v = s / 5.0;
      if (best === null || v < best) best = v;
    }
    return best;
  }
  function inside(m, intervals) { const t = m * 60; for (const [a, b] of intervals) if (a <= t && t < b) return true; return false; }
  function stress(hr, day, restBase, maxHr, busy, sdnn, sdnnBase) {
    busy = busy || []; sdnn = sdnn || [];
    const hours = new Map();
    for (const [m, v, off] of hr) {
      if (localDayOf(m, off) !== day || inside(m, busy)) continue;
      const lt = (((m * 60 + off) % 86400) + 86400) % 86400, h = Math.floor(lt / 3600);
      if (!hours.has(h)) hours.set(h, [0, 0]);
      const e = hours.get(h); e[0] += v; e[1] += 1;
    }
    const low = new Set();
    if (sdnnBase) {
      const [mu, sg] = sdnnBase;
      for (const [z, h, v] of sdnn) if (z === day && v > 0 && Math.log(v) < mu - sg) low.add(Math.trunc(h));
    }
    const out = [], span = maxHr - restBase;
    for (const h of Array.from(hours.keys()).sort((a, b) => a - b)) {
      const [tot, n] = hours.get(h);
      if (n < 10 || span <= 0) continue;
      const e = (tot / n - restBase) / span;
      let lvl = e < 0.10 ? 0 : (e < 0.20 ? 1 : (e < 0.30 ? 2 : 3));
      if (low.has(h)) lvl = Math.min(3, lvl + 1);
      out.push({ hour: h, mean_hr: tot / n, minutes: n, level: lvl, low_hrv: low.has(h) });
    }
    return out;
  }
  function detectWorkouts(hr, rest, maxHr, busy, frac, minMinutes, maxGap) {
    busy = busy || []; frac = frac === undefined ? 0.30 : frac; minMinutes = minMinutes || 10; maxGap = maxGap === undefined ? 3 : maxGap;
    const thr = rest + frac * (maxHr - rest);
    const blocks = [];
    for (const [m, v] of hr) {
      if (v < thr) continue;
      const b = blocks[blocks.length - 1];
      if (b && m - b.end <= maxGap) { b.end = m; b.sum += v; b.n += 1; }
      else blocks.push({ start: m, end: m, sum: v, n: 1 });
    }
    const out = [];
    for (const b of blocks) {
      const len = b.end - b.start + 1;
      if (len < minMinutes) continue;
      let cov = 0;
      for (let m = b.start; m <= b.end; m++) if (inside(m, busy)) cov++;
      if (cov * 2 > len) continue;
      out.push({ start: b.start * 60, end: (b.end + 1) * 60, minutes: len, avg_hr: b.sum / b.n, threshold: thr });
    }
    return out;
  }
  function dayTrimp(hr, day, s) {
    const [a, bb] = s.trimp_sex === "female" ? [0.86, 1.67] : [0.64, 1.92];
    let tot = 0;
    for (const [m, v, off] of hr) {
      if (localDayOf(m, off) !== day) continue;
      let x = (v - s.rest_hr) / (s.max_hr - s.rest_hr);
      x = x < 0 ? 0 : (x > 1 ? 1 : x);
      tot += x * a * Math.exp(bb * x);
    }
    return { trimp: tot, index: dayIndex(tot) };
  }
  function fmtClock(minutes) {
    const m = ((Math.floor(minutes + 0.5) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  }
  function sleepPlan(needH, wakeMin, latency) {
    latency = latency === undefined ? 15.0 : latency;
    const bed = (((wakeMin - needH * 60.0 - latency) % 1440) + 1440) % 1440;
    return { bedtime: fmtClock(bed), bed_min: bed, wake: fmtClock(wakeMin), window_start: fmtClock(wakeMin - 30), need_h: needH, latency_min: latency };
  }
  function stepsSummary(rows, day, days) {
    days = days || 7;
    const sel = rows.filter((r) => day - days < r.date && r.date <= day && r.steps !== null && r.steps !== undefined).map((r) => r.steps);
    return { days: sel.length, mean: mean(sel), total: sel.length ? SB.sum(sel) : 0 };
  }

  // ------------------------------------------------------------------ routes
  const N_SIG = 50;
  function signature(act, d) {
    const pos = [];
    for (let i = 0; i < d.length; i++) if (act.lat[i] !== null) pos.push([i, act.lat[i], act.lon[i]]);
    if (pos.length < 2 || d[d.length - 1] <= 0) return null;
    const dd = pos.map((p) => d[p[0]]), total = dd[dd.length - 1], pts = [];
    for (let k = 0; k < N_SIG; k++) {
      const x = total * k / (N_SIG - 1), j = bisectLeft(dd, x);
      if (j <= 0) pts.push([pos[0][1], pos[0][2]]);
      else if (j >= dd.length) pts.push([pos[pos.length - 1][1], pos[pos.length - 1][2]]);
      else {
        const f = dd[j] > dd[j - 1] ? (x - dd[j - 1]) / (dd[j] - dd[j - 1]) : 0.0;
        pts.push([pos[j - 1][1] + f * (pos[j][1] - pos[j - 1][1]), pos[j - 1][2] + f * (pos[j][2] - pos[j - 1][2])]);
      }
    }
    return { start: pts[0], end: pts[N_SIG - 1], distance: total, pts };
  }
  function sameRoute(a, b, endTol, distTol, meanTol) {
    endTol = endTol || 200.0; distTol = distTol || 0.10; meanTol = meanTol || 100.0;
    if (!a || !b) return false;
    if (haversine(a.start[0], a.start[1], b.start[0], b.start[1]) > endTol || haversine(a.end[0], a.end[1], b.end[0], b.end[1]) > endTol) return false;
    if (Math.abs(a.distance - b.distance) > distTol * Math.max(a.distance, b.distance)) return false;
    let tot = 0;
    for (let k = 0; k < N_SIG; k++) tot += haversine(a.pts[k][0], a.pts[k][1], b.pts[k][0], b.pts[k][1]);
    return tot / N_SIG <= meanTol;
  }
  function groupRoutes(sigs) {
    const groups = [];
    for (const [id, sg] of sigs) {
      if (!sg) continue;
      const g = groups.find((x) => sameRoute(x.sig, sg));
      if (g) g.ids.push(id); else groups.push({ sig: sg, ids: [id] });
    }
    return groups.map((g) => g.ids);
  }
  const escXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  function isoTime(t) {
    const z = Math.floor(t / 86400), sec = t - z * 86400, h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec - h * 3600 - m * 60);
    return dayStr(z) + "T" + String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "Z";
  }
  function toGpx(act, name) {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Pulse" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">',
      "<trk><name>" + escXml(name || act.name || "Activity") + "</name><trkseg>"];
    for (let i = 0; i < act.t.length; i++) {
      const la = act.lat[i], lo = act.lon[i];
      if (la === null || lo === null) continue;
      let p = '<trkpt lat="' + la.toFixed(7) + '" lon="' + lo.toFixed(7) + '">';
      if (act.ele[i] !== null) p += "<ele>" + act.ele[i].toFixed(1) + "</ele>";
      p += "<time>" + isoTime(act.t[i]) + "</time>";
      if (act.hr[i] !== null) p += "<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>" + Math.trunc(act.hr[i]) + "</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>";
      out.push(p + "</trkpt>");
    }
    out.push("</trkseg></trk></gpx>");
    return out.join("\n") + "\n";
  }
  const GATE_HALF = 25.0, CORRIDOR = 25.0, CORRIDOR_SHARE = 0.9;
  function gate(xy, i) {
    const a = xy[Math.max(0, i - 1)], b = xy[Math.min(xy.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.sqrt(dx * dx + dy * dy) || 1.0, ux = dx / L, uy = dy / L;
    const [cx, cy] = xy[i];
    return { p: [cx - uy * GATE_HALF, cy + ux * GATE_HALF], q: [cx + uy * GATE_HALF, cy - ux * GATE_HALF], dir: [ux, uy] };
  }
  function makeSegment(act, i0, i1, name) {
    const idx = [];
    for (let i = i0; i <= i1; i++) if (act.lat[i] !== null) idx.push(i);
    if (idx.length < 3) throw err("segment", "Pick a stretch with at least three GPS points.");
    const lat0 = act.lat[idx[0]], lon0 = act.lon[idx[0]];
    const xy = idx.map((i) => projectLocal(act.lat[i], act.lon[i], lat0, lon0));
    const step = Math.max(1, Math.floor(idx.length / 300)), ref = [];
    for (let k = 0; k < xy.length; k += step) ref.push(xy[k].slice());
    const last = xy[xy.length - 1];
    if (ref[ref.length - 1][0] !== last[0] || ref[ref.length - 1][1] !== last[1]) ref.push(last.slice());
    let length = 0;
    for (let k = 1; k < ref.length; k++) length += Math.sqrt((ref[k][0] - ref[k - 1][0]) ** 2 + (ref[k][1] - ref[k - 1][1]) ** 2);
    return { name: name || "", origin: [lat0, lon0], start: gate(xy, 0), end: gate(xy, xy.length - 1), ref, length };
  }
  function cross(a, b, g) {
    const p = g.p, q = g.q, rx = b[0] - a[0], ry = b[1] - a[1], sx = q[0] - p[0], sy = q[1] - p[1];
    const den = rx * sy - ry * sx;
    if (den === 0) return null;
    const t = ((p[0] - a[0]) * sy - (p[1] - a[1]) * sx) / den, u = ((p[0] - a[0]) * ry - (p[1] - a[1]) * rx) / den;
    if (!(t >= 0 && t <= 1 && u >= 0 && u <= 1)) return null;
    if (rx * g.dir[0] + ry * g.dir[1] <= 0) return null;
    return t;
  }
  function distToPoly(pt, ref) {
    let best = null;
    for (let k = 1; k < ref.length; k++) {
      const [ax, ay] = ref[k - 1], [bx, by] = ref[k], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const f = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / L2));
      const ex = ax + f * dx - pt[0], ey = ay + f * dy - pt[1], d = Math.sqrt(ex * ex + ey * ey);
      if (best === null || d < best) best = d;
    }
    return best;
  }
  function matchSegment(seg, act) {
    const [lat0, lon0] = seg.origin, idx = [];
    for (let i = 0; i < act.t.length; i++) if (act.lat[i] !== null) idx.push(i);
    const xy = idx.map((i) => projectLocal(act.lat[i], act.lon[i], lat0, lon0)), out = [];
    let k = 1;
    while (k < xy.length) {
      const f = cross(xy[k - 1], xy[k], seg.start);
      if (f === null) { k++; continue; }
      const ts = act.t[idx[k - 1]] + f * (act.t[idx[k]] - act.t[idx[k - 1]]);
      let j = k + 1, found = null;
      while (j < xy.length) {
        const g = cross(xy[j - 1], xy[j], seg.end);
        if (g !== null) { found = [j, g]; break; }
        if (cross(xy[j - 1], xy[j], seg.start) !== null) break;
        j++;
      }
      if (found === null) { k++; continue; }
      const [jj, g] = found;
      let ins = 0, cnt = 0;
      for (let m = k; m < jj; m++) { cnt++; if (distToPoly(xy[m], seg.ref) <= CORRIDOR) ins++; }
      if (cnt && ins >= CORRIDOR_SHARE * cnt) {
        const te = act.t[idx[jj - 1]] + g * (act.t[idx[jj]] - act.t[idx[jj - 1]]);
        out.push({ start: ts, elapsed: te - ts });
      }
      k = jj + 1;
    }
    return out;
  }
  const MAX_DEM = 200000, CELL = 0.002;
  function parseDem(text) {
    const pts = [], lines = text.split(/\r\n|\r|\n/);
    for (let n = 1; n <= lines.length; n++) {
      const line = lines[n - 1];
      if (!line.trim()) continue;
      const sep = line.includes("\t") ? "\t" : (line.includes(";") ? ";" : ",");
      const c = line.split(sep).map((x) => x.trim());
      if (c.length < 3) throw err("dem", "Row " + n + ": expected lat, lon, elevation.");
      const la = num(c[0]), lo = num(c[1]), el = num(c[2]);
      if (la === null || lo === null || el === null) { if (n === 1) continue; throw err("dem", "Row " + n + ": lat, lon and elevation must be numbers."); }
      if (Math.abs(la) > 90 || Math.abs(lo) > 180) throw err("dem", "Row " + n + ": coordinates out of range.");
      pts.push([la, lo, el]);
      if (pts.length > MAX_DEM) throw err("rows", "The elevation file has more than 200,000 points.");
    }
    if (!pts.length) throw err("dem", "No elevation points found.");
    return pts;
  }
  function correctElevation(pts, act, radius, k) {
    radius = radius || 150.0; k = k || 4;
    const grid = new Map();
    for (const p of pts) {
      const key = Math.floor(p[0] / CELL) + "," + Math.floor(p[1] / CELL);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(p);
    }
    const out = [];
    for (let i = 0; i < act.t.length; i++) {
      const la = act.lat[i], lo = act.lon[i];
      if (la === null) { out.push(act.ele[i]); continue; }
      const gi = Math.floor(la / CELL), gj = Math.floor(lo / CELL), cand = [];
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        for (const p of grid.get((gi + di) + "," + (gj + dj)) || []) {
          const dd = haversine(la, lo, p[0], p[1]);
          if (dd <= radius) cand.push([dd, p[2]]);
        }
      }
      if (!cand.length) { out.push(act.ele[i]); continue; }
      cand.sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]));
      const near = cand.slice(0, k);
      if (near[0][0] < 0.01) { out.push(near[0][1]); continue; }
      let ws = 0, es = 0;
      for (const [dd, e] of near) { const w = 1.0 / (dd * dd); ws += w; es += w * e; }
      out.push(es / ws);
    }
    return out;
  }
  function equalize(counts) {
    const freq = new Map();
    let total = 0;
    for (const c of counts) if (c > 0) { freq.set(c, (freq.get(c) || 0) + 1); total++; }
    if (!total) return Array.from(counts, () => 0);
    const vals = Array.from(freq.keys()).sort((a, b) => a - b), cdf = new Map();
    let acc = 0;
    for (const v of vals) { acc += freq.get(v); cdf.set(v, acc / total); }
    return Array.from(counts, (c) => (c > 0 ? cdf.get(c) : 0));
  }

  // ------------------------------------------------------------------ imports
  const MAX_CSV = 50 * 1024 * 1024, MAX_ROWS = 50000;
  function parseCsv(text) {
    if (text.length > MAX_CSV) throw err("size", "CSV is over the 50 MB limit.");
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [], field = "", quoted = false;
    const n = text.length;
    const endRow = () => {
      row.push(field); field = "";
      if (row.some((x) => x !== "")) {
        rows.push(row);
        if (rows.length > MAX_ROWS + 1) throw err("rows", "The CSV has more than 50,000 rows.");
      }
      row = [];
    };
    for (let i = 0; i < n; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (i + 1 < n && text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") { endRow(); if (c === "\r" && i + 1 < n && text[i + 1] === "\n") i++; }
      else field += c;
    }
    if (field || row.length) { row.push(field); if (row.some((x) => x !== "")) rows.push(row); }
    return rows;
  }
  function csvRecords(text) {
    const rows = parseCsv(text);
    if (!rows.length) return [[], []];
    return [rows[0].map((h) => h.trim().toLowerCase()), rows.slice(1)];
  }
  function col(head, ...names) { for (const nm of names) { const i = head.indexOf(nm); if (i >= 0) return i; } return null; }
  const cell = (r, k) => (k !== null && k < r.length ? r[k].trim() : "");
  const STRAVA_SPORT = { "run": "run", "trail run": "run", "walk": "run", "hike": "run", "virtual run": "run", "ride": "ride",
    "virtual ride": "ride", "e-bike ride": "ride", "gravel ride": "ride", "mountain bike ride": "ride", "weight training": "strength" };
  const stravaSport = (t) => STRAVA_SPORT[(t || "").trim().toLowerCase()] || "other";
  function stravaIndex(text) {
    const [head, body] = csvRecords(text);
    if (!head.length) throw err("csv", "activities.csv is empty.");
    const kId = col(head, "activity id"), kDate = col(head, "activity date"), kName = col(head, "activity name");
    const kType = col(head, "activity type"), kFile = col(head, "filename"), kGear = col(head, "activity gear"), kEl = col(head, "elapsed time");
    const distCols = [];
    head.forEach((h, i) => { if (h === "distance") distCols.push(i); });
    if (kType === null || kFile === null) throw err("csv", "This does not look like Strava's activities.csv (no Activity Type or Filename).");
    const files = {}, manual = [];
    for (const r of body) {
      const e = { id: cell(r, kId), name: cell(r, kName).slice(0, 200), sport: stravaSport(cell(r, kType)), type: cell(r, kType).slice(0, 60),
        date: cell(r, kDate), gear: cell(r, kGear).slice(0, 120) };
      const f = cell(r, kFile);
      if (f) files[f.toLowerCase()] = e;
      else {
        let dist = null;
        if (distCols.length >= 2) dist = num(cell(r, distCols[distCols.length - 1]).replace(/,/g, ""));
        else if (distCols.length) { const v = num(cell(r, distCols[0]).replace(/,/g, "")); dist = v !== null ? v * 1000.0 : null; }
        e.distance = dist; e.elapsed = num(cell(r, kEl));
        manual.push(e);
      }
    }
    return { files, manual };
  }
  const bool = (s) => ["true", "yes", "1"].includes(s.trim().toLowerCase());
  const dayOf = (s) => (s && s.length >= 10 ? parseDay(s.slice(0, 10)) : null);
  // Plausible ranges; a value outside is a blank or a device error and is dropped, not imported.
  const WHOOP_RANGES = [["rmssd", 1, 400], ["rhr", 20, 150], ["wrist_temp", 20, 45], ["spo2", 50, 100], ["resp", 4, 60], ["sleep", 0, 20], ["in_bed", 0, 24]];
  function whoopCycles(text) {
    const [head, body] = csvRecords(text);
    const names = ["cycle start time", "wake onset", "sleep onset", "resting heart rate (bpm)", "heart rate variability (ms)",
      "skin temp (celsius)", "blood oxygen %", "respiratory rate (rpm)", "asleep duration (min)", "in bed duration (min)",
      "light sleep duration (min)", "deep (sws) duration (min)", "rem duration (min)"];
    const k = {};
    for (const nm of names) k[nm] = col(head, nm);
    if (k["cycle start time"] === null) throw err("csv", "physiological_cycles.csv has no 'Cycle start time' column.");
    const out = [];
    for (const r of body) {
      const z = dayOf(cell(r, k["wake onset"])) || dayOf(cell(r, k["cycle start time"]));
      if (z === null) continue;
      const d = blankDay(z);
      d.rmssd = num(cell(r, k["heart rate variability (ms)"]));
      d.rhr = num(cell(r, k["resting heart rate (bpm)"]));
      d.wrist_temp = num(cell(r, k["skin temp (celsius)"]));
      d.spo2 = num(cell(r, k["blood oxygen %"]));
      d.resp = num(cell(r, k["respiratory rate (rpm)"]));
      const a = num(cell(r, k["asleep duration (min)"]));
      d.sleep = a !== null ? a / 60.0 : null;
      const b = num(cell(r, k["in bed duration (min)"]));
      d.in_bed = b !== null ? b / 60.0 : null;
      for (const [key, lo, hi] of WHOOP_RANGES) if (d[key] !== null && !(d[key] >= lo && d[key] <= hi)) d[key] = null;
      const li = num(cell(r, k["light sleep duration (min)"])), de = num(cell(r, k["deep (sws) duration (min)"])), re = num(cell(r, k["rem duration (min)"]));
      if (li !== null || de !== null || re !== null) d.stages = { core: (li || 0) / 60.0, deep: (de || 0) / 60.0, rem: (re || 0) / 60.0, unspecified: 0.0 };
      const so = cell(r, k["sleep onset"]), wo = cell(r, k["wake onset"]);
      if (so.length >= 16 && wo.length >= 16) {
        const bm = parseInt(so.slice(11, 13), 10) * 60 + parseInt(so.slice(14, 16), 10);
        d.bed_min = bm >= 720 ? bm - 720 : bm + 720;
        d.wake_min = parseInt(wo.slice(11, 13), 10) * 60 + parseInt(wo.slice(14, 16), 10);
      }
      out.push(d);
    }
    return out;
  }
  function whoopNaps(text) {
    const [head, body] = csvRecords(text);
    const kOn = col(head, "sleep onset"), kNap = col(head, "nap"), kAs = col(head, "asleep duration (min)");
    const out = {};
    if (kNap === null) return out;
    for (const r of body) {
      if (bool(cell(r, kNap))) {
        const z = dayOf(cell(r, kOn)), a = num(cell(r, kAs));
        if (z !== null && a !== null) out[z] = (out[z] || 0) + a / 60.0;
      }
    }
    return out;
  }
  const WHOOP_SPORT = { "running": "run", "walking": "run", "hiking": "run", "cycling": "ride", "spin": "ride", "mountain biking": "ride",
    "weightlifting": "strength", "functional fitness": "strength", "powerlifting": "strength" };
  function whoopWorkouts(text) {
    const [head, body] = csvRecords(text);
    const names = ["workout start time", "duration (min)", "activity name", "energy burned (cal)", "max hr (bpm)", "average hr (bpm)", "distance (meters)", "altitude gain (meters)"];
    const k = {};
    for (const nm of names) k[nm] = col(head, nm);
    if (k["workout start time"] === null) throw err("csv", "workouts.csv has no 'Workout start time' column.");
    const out = [];
    for (const r of body) {
      const st = cell(r, k["workout start time"]), z = dayOf(st), mins = num(cell(r, k["duration (min)"]));
      if (z === null || !mins) continue;
      const nm = cell(r, k["activity name"]);
      out.push({ day: z, start_text: st.slice(0, 19), name: nm.slice(0, 200), sport: WHOOP_SPORT[nm.trim().toLowerCase()] || "other",
        duration: mins * 60.0, avg_hr: num(cell(r, k["average hr (bpm)"])), max_hr: num(cell(r, k["max hr (bpm)"])),
        kcal: num(cell(r, k["energy burned (cal)"])), distance: num(cell(r, k["distance (meters)"])), gain: num(cell(r, k["altitude gain (meters)"])) });
    }
    return out;
  }
  function whoopJournal(text) {
    const [head, body] = csvRecords(text);
    const kD = col(head, "cycle start time"), kQ = col(head, "question text"), kY = col(head, "answered yes");
    if (kQ === null || kY === null) throw err("csv", "journal_entries.csv needs 'Question text' and 'Answered yes' columns.");
    const out = {};
    for (const r of body) {
      const z = dayOf(cell(r, kD)), q = cell(r, kQ).slice(0, 120);
      if (z === null || !q) continue;
      if (!out[z]) out[z] = {};
      out[z][q] = bool(cell(r, kY));
    }
    return out;
  }
  // CSV export guard: cells that a spreadsheet would run as a formula get a leading apostrophe.
  function csvCell(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // ------------------------------------------------------------------ network gate (pure decision)
  // features: {name: {hosts: [...]}}; switches: {name: true}. Only https, only listed hosts,
  // only when that feature's switch is on. Hosts match exactly (no wildcards).
  function netDecision(features, switches, feature, url) {
    const f = features && Object.prototype.hasOwnProperty.call(features, feature) ? features[feature] : null;
    if (!f) return { ok: false, reason: "unknown feature" };
    if (!switches || switches[feature] !== true) return { ok: false, reason: "switch off" };
    let u;
    try { u = new URL(url); } catch (e) { return { ok: false, reason: "bad url" }; }
    if (u.protocol !== "https:" && !(typeof f.urls === "function" && u.protocol === "http:")) return { ok: false, reason: "not https" };
    if (u.username || u.password) return { ok: false, reason: "credentials in url" };
    if (typeof f.urls === "function") {
      // exact addresses only (the person's own AI service): https, or http to this computer
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      const allowed = (f.urls(switches) || []).map((x) => { try { return new URL(x).href; } catch (e) { return null; } });
      if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return { ok: false, reason: "not https" };
      return allowed.includes(u.href) ? { ok: true, reason: null } : { ok: false, reason: "address not allowed" };
    }
    const hosts = typeof f.hosts === "function" ? f.hosts(switches) : f.hosts;
    if (!hosts || !hosts.includes(u.hostname.toLowerCase())) return { ok: false, reason: "host not allowed" };
    if (u.port && u.port !== "443") return { ok: false, reason: "port not allowed" };
    return { ok: true, reason: null };
  }

  return {
    netDecision,
    keytelKcalPerMin, metFor, calories, vo2maxUth, vdot, riegel, bestVdot, fitnessAge, powerZoneTime, paceZoneTime, luciaTrimp,
    powerLoad, powerHrRatio, dayIndex, summaryTrimp, POWER_ZONES, PACE_ZONES,
    epley, brzycki, sessionStats, strengthRecords,
    weekStart, periodRange, totals, goalProgress, periods, weeklyBand, longestStreak, yearReview, gearTotals, weightTrend,
    bpSummary, cyclePhase, association, insights, suggest,
    efficiency, consistency, vital, overnightRhr, stress, detectWorkouts, dayTrimp, fmtClock, sleepPlan, stepsSummary, localDayOf,
    signature, sameRoute, groupRoutes, toGpx, makeSegment, matchSegment, parseDem, correctElevation, equalize,
    parseCsv, csvRecords, stravaIndex, stravaSport, whoopCycles, whoopNaps, whoopWorkouts, whoopJournal, csvCell,
  };
})());
