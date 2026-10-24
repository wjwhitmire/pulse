"""A small FIT encoder used only to build test fixtures (definitions, data, compressed
timestamps, developer fields, both byte orders, chained files)."""

import struct

from pulse.fit import BASE, FIT_EPOCH, crc16

SEMI = 2147483648.0 / 180.0

# common field definitions: (field number, size, base type byte)
FILE_ID = [(0, 1, 0x00), (4, 4, 0x86)]
RECORD = [(253, 4, 0x86), (0, 4, 0x85), (1, 4, 0x85), (78, 4, 0x86), (3, 1, 0x02),
          (4, 1, 0x02), (7, 2, 0x84), (5, 4, 0x86)]
RECORD_NOTS = RECORD[1:]
LAP = [(253, 4, 0x86), (2, 4, 0x86), (7, 4, 0x86), (8, 4, 0x86), (9, 4, 0x86), (15, 1, 0x02), (16, 1, 0x02)]
SESSION = [(253, 4, 0x86), (2, 4, 0x86), (5, 1, 0x00), (7, 4, 0x86), (8, 4, 0x86), (9, 4, 0x86),
           (16, 1, 0x02), (17, 1, 0x02)]
EVENT = [(253, 4, 0x86), (0, 1, 0x00), (1, 1, 0x00)]


def fit_ts(unix):
    return int(unix - FIT_EPOCH)


class FitWriter:
    def __init__(self):
        self.body = bytearray()
        self.defs = {}

    def define(self, local, glob, fields, little=True, dev=()):
        h = 0x40 | local | (0x20 if dev else 0)
        b = bytearray([h, 0, 0 if little else 1])
        b += struct.pack("<H" if little else ">H", glob)
        b.append(len(fields))
        for f in fields:
            b += bytes(f)
        if dev:
            b.append(len(dev))
            for f in dev:
                b += bytes(f)
        self.body += b
        self.defs[local] = (fields, little, sum(f[1] for f in dev))

    def data(self, local, values, compressed=None):
        fields, little, dev_size = self.defs[local]
        if compressed is None:
            b = bytearray([local])
        else:
            b = bytearray([0x80 | (local << 5) | (compressed & 0x1F)])
        for (num, size, bt), v in zip(fields, values):
            code, bsize, invalid = BASE[bt & 0x1F]
            count = size // bsize
            if v is None:
                v = [invalid] * count if count > 1 else invalid
            vals = v if isinstance(v, list) else [v]
            b += struct.pack(("<" if little else ">") + code * count, *vals)
        b += bytes(range(dev_size))  # developer payload: arbitrary bytes the decoder must skip
        self.body += b

    def raw(self, data):
        self.body += data

    def finish(self, header_size=14, bad_crc=False):
        hdr = bytearray([header_size, 0x20])
        hdr += struct.pack("<H", 2132)
        hdr += struct.pack("<I", len(self.body))
        hdr += b".FIT"
        if header_size == 14:
            hdr += struct.pack("<H", crc16(hdr))
        out = bytes(hdr) + bytes(self.body)
        c = crc16(out)
        if bad_crc:
            c ^= 0xFFFF
        return out + struct.pack("<H", c)


def record_values(t, lat, lon, ele, hr, cad, pwr, dist):
    return [fit_ts(t) if t is not None else None,
            None if lat is None else int(round(lat * SEMI)),
            None if lon is None else int(round(lon * SEMI)),
            None if ele is None else int(round((ele + 500.0) * 5.0)),
            hr, cad, pwr,
            None if dist is None else int(round(dist * 100.0))]


def sample_activity(n=120, start=1767225600.0, sport=1, compressed_every=3, big_endian_records=False,
                    dev=True, with_pause=True, header_size=14):
    """A synthetic run: n records at 1 s, every `compressed_every`-th record with a compressed
    timestamp header, a second record definition, developer fields, laps, session and a pause."""
    w = FitWriter()
    w.define(0, 0, FILE_ID)
    w.data(0, [4, fit_ts(start)])
    w.define(1, 20, RECORD, little=not big_endian_records, dev=[(0, 2, 0), (1, 3, 0)] if dev else ())
    w.define(2, 20, RECORD_NOTS)  # same message without a timestamp field, for compressed headers
    w.define(3, 21, EVENT)
    w.data(3, [fit_ts(start), 0, 0])
    rows = []
    for i in range(n):
        t = start + i
        lat = 41.0 + i * 2.5e-5
        lon = -40.0 + i * 1.0e-5
        ele = 100.0 + 0.2 * i
        hr = 120 + (i % 40)
        cad = 170 if i % 7 else None
        pwr = 200 + i if i % 5 else None
        dist = i * 3.0
        rows.append((t, lat, lon, ele, hr, cad, pwr, dist))
        vals = record_values(t, lat, lon, ele, hr, cad, pwr, dist)
        if compressed_every and i % compressed_every == 1:
            w.data(2, vals[1:], compressed=fit_ts(t) & 0x1F)
        else:
            w.data(1, vals)
        if with_pause and i == n // 2:
            w.data(3, [fit_ts(t), 0, 4])          # timer stop_all
        if with_pause and i == n // 2 + 5:
            w.data(3, [fit_ts(t), 0, 0])          # timer start: 5 s paused
    w.define(4, 19, LAP)
    w.data(4, [fit_ts(start + n - 1), fit_ts(start), (n - 1) * 1000, (n - 1) * 1000, (n - 1) * 300, 140, 159])
    w.define(5, 18, SESSION)
    w.data(5, [fit_ts(start + n - 1), fit_ts(start), sport, (n - 1) * 1000, (n - 1) * 1000, (n - 1) * 300, 140, 159])
    return w.finish(header_size=header_size), rows
