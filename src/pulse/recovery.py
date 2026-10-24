"""Recovery inputs: Apple Health export streaming, a generic daily CSV, rMSSD from beat-to-beat
intervals, and the readiness panel (each input against its own personal baseline)."""

from __future__ import annotations

import codecs
import math
import re
import zipfile

from .util import PulseError, mean, num, parse_day, parse_time, sd

MAX_HEALTH_BYTES = 200 * 1024 * 1024
MAX_ROWS = 50000

T_SDNN = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN"
T_RMSSD = "HKQuantityTypeIdentifierHeartRateVariabilityRMSSD"
T_RHR = "HKQuantityTypeIdentifierRestingHeartRate"
T_SLEEP = "HKCategoryTypeIdentifierSleepAnalysis"
T_STEPS = "HKQuantityTypeIdentifierStepCount"
T_ENERGY = "HKQuantityTypeIdentifierActiveEnergyBurned"
T_HR = "HKQuantityTypeIdentifierHeartRate"
T_RESP = "HKQuantityTypeIdentifierRespiratoryRate"
T_SPO2 = "HKQuantityTypeIdentifierOxygenSaturation"
T_WRIST = "HKQuantityTypeIdentifierAppleSleepingWristTemperature"
T_MASS = "HKQuantityTypeIdentifierBodyMass"
T_SYS = "HKQuantityTypeIdentifierBloodPressureSystolic"
T_DIA = "HKQuantityTypeIdentifierBloodPressureDiastolic"
IN_BED = "HKCategoryValueSleepAnalysisInBed"
WANTED = {T_SDNN, T_RMSSD, T_RHR, T_SLEEP, T_STEPS, T_ENERGY, T_HR, T_RESP, T_SPO2, T_WRIST, T_MASS, T_SYS, T_DIA}
HR_KEEP_DAYS = 120
ASLEEP = {
    "HKCategoryValueSleepAnalysisAsleep": "unspecified",
    "HKCategoryValueSleepAnalysisAsleepUnspecified": "unspecified",
    "HKCategoryValueSleepAnalysisAsleepCore": "core",
    "HKCategoryValueSleepAnalysisAsleepDeep": "deep",
    "HKCategoryValueSleepAnalysisAsleepREM": "rem",
}

_ATTR = re.compile(r'([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"')
_BEAT = re.compile(r'<InstantaneousBeatsPerMinute\b[^>]*?\btime="([^"]*)"')
_CLOCK = re.compile(r"(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?")
_ENT = re.compile(r"&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);")
_ENTS = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}


def unescape(s: str) -> str:
    """Decode the five predefined XML entities and numeric references. Nothing else is expanded."""
    def rep(m):
        g = m.group(1)
        if g[0] == "#":
            try:
                cp = int(g[2:], 16) if g[1] in "xX" else int(g[1:])
                return chr(cp) if 0 < cp < 0x110000 else ""
            except ValueError:
                return ""
        return _ENTS[g]
    return _ENT.sub(rep, s) if "&" in s else s


MAX_TAG = 1 << 20  # characters; an opening Record tag longer than this is malformed


def _tag_end(buf, i):
    """Index of the '>' that closes the tag starting at i, skipping '>' inside quoted attribute
    values; -1 when the tag is not complete yet. Linear in the tag length."""
    k = i
    while True:
        g = buf.find(">", k)
        if g < 0:
            return -1
        q = buf.find('"', k, g)
        if q < 0:
            return g
        q2 = buf.find('"', q + 1)
        if q2 < 0:
            return -1
        k = q2 + 1


def rr_from_clock(times):
    """RR intervals (ms) from consecutive beat clock times; differences taken modulo 12 h so
    12 h and 24 h clocks both work."""
    secs = []
    for s in times:
        m = _CLOCK.search(s)
        if not m:
            continue
        frac = float("0." + m.group(4)) if m.group(4) else 0.0
        secs.append((int(m.group(1)) % 12) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + frac)
    rr = []
    for i in range(1, len(secs)):
        dlt = (secs[i] - secs[i - 1]) % 43200
        rr.append(dlt * 1000.0)
    return rr


def rmssd(rr, min_pairs=20):
    """Root mean square of successive differences over accepted beats.

    A beat is accepted when 300 <= RR <= 2000 ms and it lies within 25 % of the median of the
    in-range beats. Differences are taken only between neighbours that are both accepted."""
    rng = sorted(x for x in rr if 300.0 <= x <= 2000.0)
    if len(rng) < 2:
        return None
    k = len(rng)
    med = rng[k // 2] if k % 2 else (rng[k // 2 - 1] + rng[k // 2]) / 2.0
    ok = [300.0 <= x <= 2000.0 and abs(x - med) <= 0.25 * med for x in rr]
    ss = 0.0
    cnt = 0
    for i in range(1, len(rr)):
        if ok[i] and ok[i - 1]:
            dlt = rr[i] - rr[i - 1]
            ss += dlt * dlt
            cnt += 1
    if cnt < min_pairs:
        return None
    return math.sqrt(ss / cnt)


class HealthScanner:
    """Streaming scanner for Apple Health export.xml. Feed text chunks of any size; only the
    <Record> start tags of four types (and the beat list inside HRV records) are read.
    The DTD at the top of the export is never processed and no entity is expanded."""

    KEEP = 8

    def __init__(self):
        self.buf = ""
        self.sdnn = {}      # date -> [(hour, ms)]
        self.rmssd_beats = {}
        self.rmssd_dev = {}
        self.rhr = {}       # date -> [bpm]
        self.sleep = []     # (start s, end s, start text, end text, stage, source)
        self.in_bed = []    # (start s, end s, start text, end text)
        self.sums = {}      # (type, date, source) -> summed value (steps, active energy)
        self.means = {}     # (type, date) -> [values] (respiratory rate, SpO2, wrist temperature)
        self.hr = {}        # UTC minute -> [sum, count, local offset s]
        self.sdnn_times = []  # (local day, local hour, ms) for daytime HRV
        self.body = {}      # (type, start text) -> value
        self.records = 0

    def feed(self, chunk: str):
        self.buf += chunk
        buf = self.buf
        pos = 0
        while True:
            i = buf.find("<Record", pos)
            if i < 0:
                self.buf = buf[max(pos, len(buf) - self.KEEP):]
                return
            if i + 7 >= len(buf):
                self.buf = buf[i:]
                return
            if buf[i + 7] not in " \t\r\n/>":
                pos = i + 7
                continue
            e = _tag_end(buf, i)
            if e < 0:
                if len(buf) - i > MAX_TAG:
                    # no real Record tag is this long: skip the malformed one instead of buffering forever
                    pos = i + 7
                    continue
                self.buf = buf[i:]
                return
            tag = buf[i:e + 1]
            body = ""
            nxt = e + 1
            if not tag.endswith("/>") and T_SDNN in tag:
                c = buf.find("</Record>", e + 1)
                if c < 0:
                    if len(buf) - i < 4_000_000:
                        self.buf = buf[i:]
                        return
                else:
                    body = buf[e + 1:c]
                    nxt = c + 9
            self._handle(tag, body)
            pos = nxt

    def _handle(self, tag, body):
        typ_at = tag.find('type="')
        if typ_at < 0:
            return
        typ = tag[typ_at + 6:tag.find('"', typ_at + 6)]
        if typ not in WANTED:
            return
        a = {k: unescape(v) for k, v in _ATTR.findall(tag)}
        start = a.get("startDate", "")
        if len(start) < 13 or parse_day(start[:10]) is None:
            return
        self.records += 1
        date = start[:10]
        hour = num(start[11:13])
        if typ == T_SLEEP:
            val = a.get("value", "")
            stage = ASLEEP.get(val)
            t0 = parse_time(start)
            t1 = parse_time(a.get("endDate", ""))
            if t0 is not None and t1 is not None and t1 > t0:
                if stage:
                    self.sleep.append((t0, t1, start, a.get("endDate", ""), stage, a.get("sourceName", "")))
                elif val == IN_BED:
                    self.in_bed.append((t0, t1, start, a.get("endDate", "")))
            return
        v = num(a.get("value"))
        if v is None:
            return
        if typ in (T_STEPS, T_ENERGY):
            if typ == T_ENERGY and a.get("unit") == "kJ":
                v = v / 4.184
            key = (typ, date, a.get("sourceName", ""))
            self.sums[key] = self.sums.get(key, 0.0) + v
        elif typ in (T_RESP, T_SPO2, T_WRIST):
            if typ == T_SPO2 and v <= 1.0:
                v = v * 100.0
            if typ == T_WRIST and a.get("unit") == "degF":
                v = (v - 32.0) / 1.8
            self.means.setdefault((typ, date), []).append(v)
        elif typ == T_HR:
            t0 = parse_time(start)
            loc = parse_time(start[:19])
            if t0 is not None and loc is not None:
                m = int(t0 // 60)
                b = self.hr.get(m)
                if b is None:
                    self.hr[m] = [v, 1, loc - t0]
                else:
                    b[0] += v
                    b[1] += 1
        elif typ in (T_MASS, T_SYS, T_DIA):
            if typ == T_MASS and a.get("unit") == "lb":
                v = v * 0.45359237
            self.body[(typ, start)] = v
        elif typ == T_RHR:
            self.rhr.setdefault(date, []).append(v)
        elif typ == T_RMSSD:
            self.rmssd_dev.setdefault(date, []).append((hour, v))
        else:
            self.sdnn.setdefault(date, []).append((hour, v))
            if hour is not None:
                self.sdnn_times.append((parse_day(date), hour, v))
            if body:
                r = rmssd(rr_from_clock(_BEAT.findall(body)))
                if r is not None:
                    self.rmssd_beats.setdefault(date, []).append((hour, r))

    def result(self):
        return health_days(self)


def _morning_geo(pairs):
    """Geometric mean of readings taken before 10:00 local, or of all readings if none are."""
    early = [v for h, v in pairs if h is not None and h < 10 and v > 0]
    use = early if early else [v for _, v in pairs if v > 0]
    if not use:
        return None
    return math.exp(sum(math.log(v) for v in use) / len(use))


def sleep_nights(intervals):
    """Union of asleep intervals across sources, grouped into blocks split by gaps over 60 min.
    A block under 3 h that starts between 09:00 and 20:00 local is a nap (dated by its start);
    every other block is main sleep (dated by the local day it ends)."""
    ivs = sorted((a, b, sa, sb) for a, b, sa, sb, _, _ in intervals)
    merged = []
    for a, b, sa, sb in ivs:
        if merged and a <= merged[-1][1]:
            if b > merged[-1][1]:
                merged[-1][1] = b
                merged[-1][3] = sb
        else:
            merged.append([a, b, sa, sb])
    blocks = []
    for m in merged:
        if blocks and m[0] - blocks[-1]["end"] <= 3600:
            blk = blocks[-1]
            blk["end"] = m[1]
            blk["end_s"] = m[3]
            blk["asleep"] += m[1] - m[0]
        else:
            blocks.append({"start": m[0], "end": m[1], "start_s": m[2], "end_s": m[3], "asleep": m[1] - m[0]})
    main, nap = {}, {}
    for blk in blocks:
        h = num(blk["start_s"][11:13]) or 0.0
        if blk["asleep"] < 3 * 3600 and 9 <= h < 20:
            z = parse_day(blk["start_s"][:10])
            nap[z] = nap.get(z, 0.0) + blk["asleep"] / 3600.0
        else:
            z = parse_day(blk["end_s"][:10])
            main[z] = main.get(z, 0.0) + blk["asleep"] / 3600.0
    return main, nap


def sleep_stages(intervals):
    """Imported stage totals (hours) per wake day, from the one source with the most staged time
    that day, so two devices are not double counted. Stages are never computed here."""
    per = {}
    for a, b, sa, sb, stage, src in intervals:
        z = parse_day(sb[:10])
        if z is None:
            continue
        per.setdefault(z, {}).setdefault(src, {}).setdefault(stage, 0.0)
        per[z][src][stage] += (b - a) / 3600.0
    out = {}
    for z, srcs in per.items():
        best = max(sorted(srcs), key=lambda s: sum(srcs[s].values()))
        out[z] = {k: srcs[best].get(k, 0.0) for k in ("core", "deep", "rem", "unspecified")}
    return out


DAY_KEYS = ("rmssd", "sdnn", "rhr", "sleep", "nap", "stages", "in_bed", "bed_min", "wake_min",
            "steps", "active_kcal", "resp", "spo2", "wrist_temp")


def blank_day(z):
    d = {"date": z}
    for k in DAY_KEYS:
        d[k] = None
    return d


def clock_min(text):
    """Minutes after local midnight from an Apple date text 'YYYY-MM-DD hh:mm:ss ...'."""
    return int(text[11:13]) * 60 + int(text[14:16])


def health_days(sc: HealthScanner):
    days = {}

    def row(z):
        return days.setdefault(z, blank_day(z))
    for date, pairs in sc.sdnn.items():
        row(parse_day(date))["sdnn"] = _morning_geo(pairs)
    for src in (sc.rmssd_beats, sc.rmssd_dev):  # device rMSSD, when present, wins
        for date, pairs in src.items():
            v = _morning_geo(pairs)
            if v is not None:
                row(parse_day(date))["rmssd"] = v
    for date, vals in sc.rhr.items():
        row(parse_day(date))["rhr"] = sum(vals) / len(vals)
    main, nap = sleep_nights(sc.sleep)
    for z, h in main.items():
        row(z)["sleep"] = h
    for z, h in nap.items():
        row(z)["nap"] = h
    for z, st in sleep_stages(sc.sleep).items():
        row(z)["stages"] = st
    for z, w in main_windows(sc.sleep).items():
        r = row(z)
        r["bed_min"] = clock_min(w[2]) - 720 if clock_min(w[2]) >= 720 else clock_min(w[2]) + 720
        r["wake_min"] = clock_min(w[3])
        r["in_bed"] = (w[1] - w[0]) / 3600.0
    for z, h in in_bed_hours(sc.in_bed).items():
        r = row(z)
        if h > (r["in_bed"] or 0.0):
            r["in_bed"] = h
    best = {}
    for (typ, date, _src), v in sorted(sc.sums.items()):
        key = (typ, date)
        if v > best.get(key, -1.0):
            best[key] = v
    for (typ, date), v in best.items():
        row(parse_day(date))["steps" if typ == T_STEPS else "active_kcal"] = v
    for (typ, date), vals in sc.means.items():
        row(parse_day(date))[{T_RESP: "resp", T_SPO2: "spo2", T_WRIST: "wrist_temp"}[typ]] = sum(vals) / len(vals)
    return [days[z] for z in sorted(days)]


def main_windows(intervals):
    """(start s, end s, start text, end text) of the main sleep block per wake day: the span of
    the merged asleep blocks that are not naps."""
    ivs = sorted((a, b, sa, sb) for a, b, sa, sb, _, _ in intervals)
    blocks = []
    for a, b, sa, sb in ivs:
        if blocks and a - blocks[-1][1] <= 3600:
            if b > blocks[-1][1]:
                blocks[-1][1], blocks[-1][3] = b, sb
        else:
            blocks.append([a, b, sa, sb])
    out = {}
    for a, b, sa, sb in blocks:
        h = int(sa[11:13])
        if b - a < 3 * 3600 and 9 <= h < 20:
            continue
        z = parse_day(sb[:10])
        if z not in out or b - a > out[z][1] - out[z][0]:
            out[z] = (a, b, sa, sb)
    return out


def in_bed_hours(intervals):
    """Union of in-bed intervals, dated by the local day each block ends."""
    ivs = sorted(intervals)
    merged = []
    for a, b, sa, sb in ivs:
        if merged and a <= merged[-1][1]:
            if b > merged[-1][1]:
                merged[-1][1], merged[-1][3] = b, sb
        else:
            merged.append([a, b, sa, sb])
    out = {}
    for a, b, _sa, sb in merged:
        z = parse_day(sb[:10])
        out[z] = out.get(z, 0.0) + (b - a) / 3600.0
    return out


def health_extras(sc: HealthScanner):
    """Minute heart rate (last 120 days of the export), daytime SDNN readings and body entries."""
    hr = []
    if sc.hr:
        last = max(sc.hr)
        lo = last - HR_KEEP_DAYS * 1440
        for m in sorted(sc.hr):
            if m > lo:
                s_, c, off = sc.hr[m]
                hr.append([m, s_ / c, off])
    body = {}
    for (typ, start), v in sorted(sc.body.items()):
        z = parse_day(start[:10])
        e = body.setdefault(start[:16], {"date": z, "kg": None, "sys": None, "dia": None})
        e[{T_MASS: "kg", T_SYS: "sys", T_DIA: "dia"}[typ]] = v
    return {"hr": hr, "sdnn": [list(x) for x in sorted(sc.sdnn_times)],
            "body": [body[k] for k in sorted(body)]}


def scan_text_chunks(chunks):
    sc = HealthScanner()
    for c in chunks:
        sc.feed(c)
    return sc.result(), sc.records


def _decode_stream(fh, chunk=1 << 20, limit=None):
    dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
    total = 0
    while True:
        b = fh.read(chunk)
        total += len(b)
        if limit is not None and total > limit:
            raise PulseError("zip", "export.xml inflates past its declared size; the zip is damaged or a zip bomb.")
        if not b:
            tail = dec.decode(b"", final=True)
            if tail:
                yield tail
            return
        yield dec.decode(b)


def read_health(path: str):
    """Read export.zip or export.xml from a path. Streams in 1 MB chunks."""
    import os
    size = os.path.getsize(path)
    if size > MAX_HEALTH_BYTES:
        raise PulseError("size", "Health export is over the 200 MB limit.")
    with open(path, "rb") as fh:
        head = fh.read(4)
    if head[:4] == b"PK\x03\x04":
        with zipfile.ZipFile(path) as zf:
            name = find_export_name([i.filename for i in zf.infolist()])
            if name is None:
                raise PulseError("zip", "No export.xml inside the zip.")
            info = zf.getinfo(name)
            if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise PulseError("zip", "export.xml uses an unsupported compression method.")
            with zf.open(name) as fh:
                # zip bomb guard: same limit as the browser (declared size, at most 100 x compressed)
                limit = min(info.file_size, 100 * info.compress_size + 64 * 1024 * 1024)
                return scan_text_chunks(_decode_stream(fh, limit=limit))
    with open(path, "rb") as fh:
        return scan_text_chunks(_decode_stream(fh))


def find_export_name(names):
    best = None
    for n in names:
        base = n.rsplit("/", 1)[-1]
        if base == "export.xml" and (best is None or len(n) < len(best)):
            best = n
    return best


_CSV_COLS = {"date": "date", "day": "date", "hrv_ms": "rmssd", "rmssd_ms": "rmssd", "rmssd": "rmssd",
             "hrv": "rmssd", "sdnn_ms": "sdnn", "sdnn": "sdnn", "resting_hr": "rhr", "rhr": "rhr",
             "sleep_hours": "sleep", "sleep_h": "sleep", "sleep": "sleep", "nap_hours": "nap", "nap_h": "nap"}


def parse_daily_csv(text: str):
    """Generic daily CSV: date, hrv_ms, resting_hr, sleep_hours (header optional; also accepts
    rmssd_ms, sdnn_ms, nap_hours). hrv_ms is read as rMSSD. Comma, tab or semicolon separated."""
    if len(text) > MAX_HEALTH_BYTES:
        raise PulseError("size", "CSV is over the size limit.")
    if text.startswith("﻿"):
        text = text[1:]
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        raise PulseError("csv", "The CSV is empty.")
    if len(lines) > MAX_ROWS + 1:
        raise PulseError("rows", "The CSV has more than 50,000 rows.")
    first = lines[0]
    sep = "\t" if "\t" in first else (";" if ";" in first and "," not in first else ",")
    cells = [c.strip().strip('"').strip().lower() for c in first.split(sep)]
    if parse_day(cells[0]) is None:
        cols = [_CSV_COLS.get(c) for c in cells]
        if "date" not in cols:
            raise PulseError("csv", "The header has no 'date' column.")
        body = lines[1:]
    else:
        cols = ["date", "rmssd", "rhr", "sleep"]
        body = lines
    out = []
    for n, ln in enumerate(body, start=2 if body is not lines else 1):
        parts = [c.strip().strip('"').strip() for c in ln.split(sep)]
        rec = blank_day(None)
        for c, v in zip(cols, parts):
            if c is None:
                continue
            if c == "date":
                rec["date"] = parse_day(v)
            elif v != "":
                x = num(v.replace(",", ".") if sep == ";" else v)  # ";" files use decimal commas
                if x is None:
                    raise PulseError("csv", f"Row {n}: '{v[:20]}' is not a number.")
                rec[c] = x
        if rec["date"] is None:
            raise PulseError("csv", f"Row {n}: the date must be YYYY-MM-DD.")
        for k in ("rmssd", "sdnn"):
            if rec[k] is not None and not (1 <= rec[k] <= 400):
                raise PulseError("csv", f"Row {n}: HRV {rec[k]} ms is outside 1 to 400.")
        if rec["rhr"] is not None and not (20 <= rec["rhr"] <= 150):
            raise PulseError("csv", f"Row {n}: resting HR {rec['rhr']} is outside 20 to 150.")
        if rec["sleep"] is not None and not (0 <= rec["sleep"] <= 20):
            raise PulseError("csv", f"Row {n}: sleep {rec['sleep']} h is outside 0 to 20.")
        out.append(rec)
    return out


# ---------------------------------------------------------------- readiness

BASE_DAYS = 60
MIN_BASE = 14
MIN_WEEK = 3


def _window(m, a, b):
    return [m[z] for z in range(a, b + 1) if m.get(z) is not None]


def readiness(daily, day, settings, loads=None):
    """Readiness inputs for `day`, each against its own baseline (the 60 days before `day`).

    HRV: 7-day mean of ln(HRV), needs 3 or more readings in the week and 14 in the baseline;
         normal range = baseline mean +/- 0.5 SD of daily ln values (smallest worthwhile change).
         rMSSD is used when it has 14 baseline days; otherwise SDNN with its own baseline.
         The two are never mixed.
    Resting HR: mean of the last 3 days against baseline mean + max(1 SD, 1 bpm).
    Sleep: last night's main sleep against need = base + share x 7-night debt
           + optional load term - yesterday's naps (floored at half the base).
    State: "clear" with no flags, "one_off" with one, "several_off" with two or more (plain
    names on purpose: readiness is never shown as a traffic light).
    """
    s = settings
    by = {r["date"]: r for r in daily}
    loads = loads or {}

    def series(key):
        return {z: r[key] for z, r in by.items() if r.get(key) is not None}

    out = {"day": day, "hrv": None, "rhr": None, "sleep": None, "flags": [], "state": "none"}
    available = 0
    # HRV
    metric = None
    for key in ("rmssd", "sdnn"):
        ser = series(key)
        if len([v for v in _window(ser, day - BASE_DAYS, day - 1) if v > 0]) >= MIN_BASE:
            metric = key
            break
    if metric:
        ser = {z: math.log(v) for z, v in series(metric).items() if v > 0}
        base = _window(ser, day - BASE_DAYS, day - 1)
        week = _window(ser, day - 6, day)
        mu, sig = mean(base), sd(base)
        info = {"metric": metric, "base_n": len(base), "week_n": len(week), "mean": mu, "sd": sig,
                "lo": mu - 0.5 * sig, "hi": mu + 0.5 * sig, "roll": None, "status": "insufficient"}
        if len(week) >= MIN_WEEK:
            roll = mean(week)
            info["roll"] = roll
            info["status"] = "low" if roll < info["lo"] else ("high" if roll > info["hi"] else "normal")
            available += 1
            if info["status"] == "low":
                out["flags"].append("hrv")
        out["hrv"] = info
    # resting HR
    rser = series("rhr")
    base = _window(rser, day - BASE_DAYS, day - 1)
    if len(base) >= MIN_BASE:
        recent = _window(rser, day - 2, day)
        mu, sig = mean(base), sd(base)
        lim = mu + max(sig, 1.0)
        info = {"base_n": len(base), "mean": mu, "sd": sig, "limit": lim, "recent": None, "status": "insufficient"}
        if recent:
            cur = mean(recent)
            info["recent"] = cur
            info["status"] = "high" if cur > lim else "normal"
            available += 1
            if info["status"] == "high":
                out["flags"].append("rhr")
        out["rhr"] = info
    # sleep
    sser = series("sleep")
    nser = series("nap")
    if sser.get(day) is not None:
        b = s["sleep_base"]
        debt = sum(max(0.0, b - sser[z]) for z in range(day - 7, day) if sser.get(z) is not None)
        nap = nser.get(day - 1, 0.0)
        ld = loads.get(day - 1, 0.0)
        need = b + s["sleep_debt_share"] * debt + s["sleep_load_per100"] * ld / 100.0 - nap
        need = max(need, 0.5 * b)
        ratio = sser[day] / need
        out["sleep"] = {"hours": sser[day], "need": need, "base": b, "debt": debt, "nap": nap,
                        "load_term": s["sleep_load_per100"] * ld / 100.0, "ratio": ratio,
                        "status": "short" if ratio < 0.85 else "ok"}
        available += 1
        if ratio < 0.85:
            out["flags"].append("sleep")
    if available:
        nf = len(out["flags"])
        out["state"] = "several_off" if nf >= 2 else ("one_off" if nf == 1 else "clear")
    return out


def explain(r) -> str:
    """Plain-language reason for a readiness state."""
    if r["state"] == "none":
        return "Not enough recovery data yet: 14 days of baseline are needed for HRV or resting HR, or a sleep entry for last night."
    parts = []
    h = r["hrv"]
    if h and h["roll"] is not None:
        label = "rMSSD" if h["metric"] == "rmssd" else "SDNN"
        word = {"low": "below", "high": "above", "normal": "inside"}[h["status"]]
        parts.append(f"7-day HRV ({label}) is {word} your normal range")
    k = r["rhr"]
    if k and k["recent"] is not None:
        parts.append("resting HR is above your usual" if k["status"] == "high" else "resting HR is normal")
    sl = r["sleep"]
    if sl:
        parts.append(f"sleep was {sl['hours']:.1f} h of a {sl['need']:.1f} h need")
    lead = {"clear": "No input is off its baseline.",
            "one_off": "One input is off its baseline.",
            "several_off": "Two or more inputs are off their baselines."}[r["state"]]
    return lead + " " + "; ".join(parts) + "."
