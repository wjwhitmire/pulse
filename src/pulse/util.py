"""Shared helpers: errors, strict number parsing, calendar math, ISO 8601 times, haversine.

Every function here has a twin in the JS core of web/app.html. Keep the arithmetic
in the same order in both so the parity test holds to 1e-9.
"""

from __future__ import annotations

import math
import re

EARTH_R = 6371008.8  # mean Earth radius in metres (IUGG)


class PulseError(ValueError):
    """A parse or input error with a stable short code and a human message."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


_NUM = re.compile(r"^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$")


def num(s):
    """Strict decimal parse. Returns None for blank or non-numeric text (no 'nan', no '1_0')."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s) if math.isfinite(s) else None
    if not _NUM.match(s):
        return None
    v = float(s)
    return v if math.isfinite(v) else None


def days_from_civil(y: int, m: int, d: int) -> int:
    """Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm)."""
    y -= 1 if m <= 2 else 0
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def civil_from_days(z: int):
    z += 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + (3 if mp < 10 else -9)
    return (y + (1 if m <= 2 else 0), m, d)


def day_str(z: int) -> str:
    y, m, d = civil_from_days(z)
    return f"{y:04d}-{m:02d}-{d:02d}"


_DATE = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})\s*$")


def parse_day(s: str):
    """'YYYY-MM-DD' to day number, or None."""
    m = _DATE.match(s or "")
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None
    z = days_from_civil(y, mo, d)
    return z if civil_from_days(z) == (y, mo, d) else None


_ISO = re.compile(
    r"^\s*(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)\s*([Zz]|[+-]\d{2}:?\d{2})?\s*$"
)


def parse_time(s):
    """ISO 8601 date-time (or Apple Health 'YYYY-MM-DD hh:mm:ss -0500') to Unix seconds.

    A time without a zone is read as UTC. Returns None when the text is not a time.
    """
    if s is None:
        return None
    m = _ISO.match(s)
    if not m:
        return None
    y, mo, d, hh, mi = (int(m.group(i)) for i in range(1, 6))
    sec = float(m.group(6))
    if not (1 <= mo <= 12 and 1 <= d <= 31 and hh <= 24 and mi <= 59 and sec < 61):
        return None
    if civil_from_days(days_from_civil(y, mo, d)) != (y, mo, d):
        return None
    off = 0
    z = m.group(7)
    if z and z not in ("Z", "z"):
        sign = -1 if z[0] == "-" else 1
        digits = z[1:].replace(":", "")
        off = sign * (int(digits[:2]) * 3600 + int(digits[2:]) * 60)
    return days_from_civil(y, mo, d) * 86400 + hh * 3600 + mi * 60 + sec - off


def haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres on a sphere of radius EARTH_R."""
    p1 = lat1 * math.pi / 180
    p2 = lat2 * math.pi / 180
    dp = (lat2 - lat1) * math.pi / 180
    dl = (lon2 - lon1) * math.pi / 180
    s1 = math.sin(dp / 2)
    s2 = math.sin(dl / 2)
    a = s1 * s1 + math.cos(p1) * math.cos(p2) * s2 * s2
    return 2 * EARTH_R * math.asin(math.sqrt(min(1.0, a)))


def project_local(lat, lon, lat0, lon0):
    """Equirectangular projection about (lat0, lon0) in metres, equal aspect. x east, y north."""
    k = math.pi / 180 * EARTH_R
    return ((lon - lon0) * k * math.cos(lat0 * math.pi / 180), (lat - lat0) * k)


def mean(xs):
    return sum(xs) / len(xs) if xs else None


def sd(xs):
    """Sample standard deviation (n - 1)."""
    n = len(xs)
    if n < 2:
        return None
    m = sum(xs) / n
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1))
