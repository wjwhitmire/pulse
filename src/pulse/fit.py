"""Garmin FIT binary decoder (activity files), written from the public FIT protocol description.

Handles: 12 and 14 byte headers, header and file CRC (a mismatch is a warning, not a failure),
definition and data messages, little and big endian definitions, compressed timestamp headers,
developer fields (skipped by their declared size), invalid-value sentinels, and chained FIT
files. Reads file_id, record, lap, session, event (timer start and stop) and hrv (RR interval)
messages. Everything else is skipped by size.
"""

from __future__ import annotations

import math
import struct

from .util import PulseError

FIT_EPOCH = 631065600  # 1989-12-31T00:00:00Z in Unix seconds
SEMI = 180.0 / 2147483648.0  # semicircles to degrees
MAX_BYTES = 50 * 1024 * 1024

# base type number (low 5 bits) -> (struct code, size, invalid value or None)
BASE = {
    0: ("B", 1, 0xFF), 1: ("b", 1, 0x7F), 2: ("B", 1, 0xFF), 3: ("h", 2, 0x7FFF),
    4: ("H", 2, 0xFFFF), 5: ("i", 4, 0x7FFFFFFF), 6: ("I", 4, 0xFFFFFFFF), 7: (None, 1, None),
    8: ("f", 4, None), 9: ("d", 8, None), 10: ("B", 1, 0), 11: ("H", 2, 0), 12: ("I", 4, 0),
    13: (None, 1, None), 14: (None, 8, None), 15: (None, 8, None), 16: (None, 8, None),
}

CRC_TABLE = (0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
             0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400)

SPORTS = {1: "run", 2: "ride", 11: "run"}  # 11 = walking, grouped with foot sports

MSG_FILE_ID, MSG_SESSION, MSG_LAP, MSG_RECORD, MSG_EVENT, MSG_HRV = 0, 18, 19, 20, 21, 78


def crc16(data, crc=0):
    for byte in data:
        tmp = CRC_TABLE[crc & 0xF]
        crc = (crc >> 4) & 0x0FFF
        crc = crc ^ tmp ^ CRC_TABLE[byte & 0xF]
        tmp = CRC_TABLE[crc & 0xF]
        crc = (crc >> 4) & 0x0FFF
        crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xF]
    return crc


def _read_value(buf, pos, size, bt, little):
    """Return a scalar (first element of an array) or a list for hrv time arrays; None if invalid."""
    code, bsize, invalid = BASE.get(bt & 0x1F, (None, 1, None))
    if code is None or size < bsize or size % bsize:
        return None
    count = size // bsize
    fmt = ("<" if little else ">") + code * count
    vals = struct.unpack_from(fmt, buf, pos)
    out = []
    for v in vals:
        if code in ("f", "d"):
            out.append(None if not math.isfinite(v) else v)
        else:
            out.append(None if v == invalid else v)
    return out[0] if count == 1 else out


MAX_MESSAGES = 3_000_000  # a day-long 1 s recording has about 90,000; caps hostile files of tiny messages


def _decode_one(buf, start, warnings):
    """Decode one FIT file starting at `start`. Returns (messages, end_offset)."""
    n = len(buf)
    if n - start < 12:
        raise PulseError("fit_header", "File is too short to be a FIT file.")
    hsize = buf[start]
    if hsize not in (12, 14) or n - start < hsize:
        raise PulseError("fit_header", "Not a FIT file (bad header size).")
    if bytes(buf[start + 8:start + 12]) != b".FIT":
        raise PulseError("fit_header", "Not a FIT file (missing .FIT signature).")
    data_size = struct.unpack_from("<I", buf, start + 4)[0]
    if hsize == 14:
        hcrc = struct.unpack_from("<H", buf, start + 12)[0]
        if hcrc != 0 and hcrc != crc16(buf[start:start + 12]):
            warnings.append("header CRC mismatch")
    pos = start + hsize
    end = pos + data_size
    if end > n:
        warnings.append("file is truncated; decoded what was present")
        end = n
    defs = {}
    last_ts = None
    msgs = []
    while pos < end:
        h = buf[pos]
        pos += 1
        if h & 0x80:  # compressed timestamp header
            local = (h >> 5) & 0x03
            off = h & 0x1F
            if last_ts is None:
                raise PulseError("fit_def", "Compressed timestamp before any full timestamp.")
            ts = (last_ts & ~0x1F) + off
            if off < (last_ts & 0x1F):
                ts += 0x20
            last_ts = ts
            d = defs.get(local)
            if d is None:
                raise PulseError("fit_def", "Data message uses an undefined local message type.")
            fields, pos = _read_data(buf, pos, end, d)
            fields[253] = ts
            msgs.append((d["global"], fields))
            if len(msgs) > MAX_MESSAGES:
                raise PulseError("size", "The FIT file has more messages than any real activity (over 3 million).")
            continue
        local = h & 0x0F
        if h & 0x40:  # definition message
            if pos + 5 > end:
                raise PulseError("fit_truncated", "Definition message runs past the end of the data.")
            little = buf[pos + 1] == 0
            glob = struct.unpack_from("<H" if little else ">H", buf, pos + 2)[0]
            nf = buf[pos + 4]
            pos += 5
            if pos + nf * 3 > end:
                raise PulseError("fit_truncated", "Definition message runs past the end of the data.")
            fdefs = []
            for _ in range(nf):
                fdefs.append((buf[pos], buf[pos + 1], buf[pos + 2]))
                pos += 3
            dev_size = 0
            if h & 0x20:
                if pos + 1 > end:
                    raise PulseError("fit_truncated", "Developer field count missing.")
                nd = buf[pos]
                pos += 1
                if pos + nd * 3 > end:
                    raise PulseError("fit_truncated", "Developer field definitions run past the end.")
                for _ in range(nd):
                    dev_size += buf[pos + 1]
                    pos += 3
            defs[local] = {"global": glob, "little": little, "fields": fdefs, "dev": dev_size}
            continue
        d = defs.get(local)
        if d is None:
            raise PulseError("fit_def", "Data message uses an undefined local message type.")
        fields, pos = _read_data(buf, pos, end, d)
        if 253 in fields and fields[253] is not None:
            last_ts = fields[253]
        msgs.append((d["global"], fields))
        if len(msgs) > MAX_MESSAGES:
            raise PulseError("size", "The FIT file has more messages than any real activity (over 3 million).")
    if end + 2 <= n and end == start + hsize + data_size:
        fcrc = struct.unpack_from("<H", buf, end)[0]
        if fcrc != crc16(buf[start:end]):
            warnings.append("file CRC mismatch")
        end += 2
    return msgs, end


def _read_data(buf, pos, end, d):
    size = sum(f[1] for f in d["fields"]) + d["dev"]
    if pos + size > end:
        raise PulseError("fit_truncated", "Data message runs past the end of the data.")
    fields = {}
    for num, fsize, bt in d["fields"]:
        fields[num] = _read_value(buf, pos, fsize, bt, d["little"])
        pos += fsize
    pos += d["dev"]  # developer fields are skipped by declared size
    return fields, pos


def _scaled(v, scale, offset=0.0):
    if v is None or isinstance(v, list):
        return None
    return v / scale - offset


def _ts(v):
    return None if v is None or isinstance(v, list) else v + FIT_EPOCH


def decode_fit(data) -> dict:
    """Decode FIT bytes into one activity dict (see analysis.empty_activity for the shape)."""
    buf = bytes(data)
    if len(buf) > MAX_BYTES:
        raise PulseError("size", "FIT file is over the 50 MB limit.")
    if len(buf) < 12:
        raise PulseError("fit_header", "File is too short to be a FIT file.")
    warnings = []
    msgs = []
    pos = 0
    while pos < len(buf):
        if len(buf) - pos < 12:
            break
        m, pos = _decode_one(buf, pos, warnings)
        msgs.extend(m)
        if pos < len(buf) and (len(buf) - pos < 12 or buf[pos] not in (12, 14)):
            break
    act = {"source": "fit", "name": "", "sport": "other", "start": None,
           "t": [], "lat": [], "lon": [], "ele": [], "hr": [], "cad": [], "pwr": [], "dist": [],
           "laps": [], "session": None, "pauses": [], "rr": [], "warnings": warnings}
    sport = None
    timer_stop = None
    for glob, f in msgs:
        if glob == MSG_FILE_ID:
            ftype = f.get(0)
            if ftype is not None and ftype != 4:
                raise PulseError("fit_type", "This FIT file is not an activity (file type %d)." % ftype)
        elif glob == MSG_RECORD:
            t = _ts(f.get(253))
            if t is None:
                continue
            lat = f.get(0)
            lon = f.get(1)
            lat = None if lat is None or isinstance(lat, list) else lat * SEMI
            lon = None if lon is None or isinstance(lon, list) else lon * SEMI
            if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
                lat = lon = None
            ele = _scaled(f.get(78), 5.0, 500.0)
            if ele is None:
                ele = _scaled(f.get(2), 5.0, 500.0)
            row = (t, lat, lon, ele, _scaled(f.get(3), 1.0), _scaled(f.get(4), 1.0),
                   _scaled(f.get(7), 1.0), _scaled(f.get(5), 100.0))
            if act["t"] and t == act["t"][-1]:
                # merge duplicate timestamps: keep the first non-missing value of each channel
                for key, v in zip(("lat", "lon", "ele", "hr", "cad", "pwr", "dist"), row[1:]):
                    if act[key][-1] is None and v is not None:
                        act[key][-1] = v
                continue
            if act["t"] and t < act["t"][-1]:
                warnings.append("record out of time order skipped")
                continue
            for key, v in zip(("t", "lat", "lon", "ele", "hr", "cad", "pwr", "dist"), row):
                act[key].append(v)
        elif glob == MSG_LAP:
            act["laps"].append({
                "start": _ts(f.get(2)), "elapsed": _scaled(f.get(7), 1000.0),
                "timer": _scaled(f.get(8), 1000.0), "distance": _scaled(f.get(9), 100.0),
                "avg_hr": _scaled(f.get(15), 1.0), "max_hr": _scaled(f.get(16), 1.0)})
        elif glob == MSG_SESSION:
            if act["session"] is None:
                sp = f.get(5)
                sport = SPORTS.get(sp, "other") if sp is not None else None
                act["session"] = {
                    "start": _ts(f.get(2)), "elapsed": _scaled(f.get(7), 1000.0),
                    "timer": _scaled(f.get(8), 1000.0), "distance": _scaled(f.get(9), 100.0),
                    "avg_hr": _scaled(f.get(16), 1.0), "max_hr": _scaled(f.get(17), 1.0),
                    "ascent": _scaled(f.get(22), 1.0), "avg_power": _scaled(f.get(20), 1.0),
                    "sport": sport}
        elif glob == MSG_EVENT:
            # event 0 = timer; event_type 0 = start, 1 = stop, 4 = stop_all
            if f.get(0) == 0:
                t = _ts(f.get(253))
                et = f.get(1)
                if t is None:
                    continue
                if et in (1, 4) and timer_stop is None:
                    timer_stop = t
                elif et == 0 and timer_stop is not None:
                    if t > timer_stop:
                        act["pauses"].append([timer_stop, t])
                    timer_stop = None
        elif glob == MSG_HRV:
            v = f.get(0)
            vals = v if isinstance(v, list) else [v]
            for x in vals:
                if x is not None:
                    act["rr"].append(x)  # milliseconds (raw value is seconds with scale 1000)
    if len(act["t"]) < 2 and not act["rr"]:
        raise PulseError("nopoints", "The FIT file has no timed record messages.")
    act["sport"] = sport or "other"
    act["start"] = act["t"][0] if act["t"] else (act["session"] or {}).get("start")
    return act
