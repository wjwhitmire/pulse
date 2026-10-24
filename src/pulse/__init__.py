"""Pulse: private training log and recovery analysis that runs on your own device."""

from .analysis import DEFAULTS, analyze, settings_with
from .example import generate as generate_example
from .fit import decode_fit
from .gpx import parse_gpx, parse_tcx
from .load import daily_loads, load_series
from .recovery import explain, parse_daily_csv, read_health, readiness, rmssd
from .util import PulseError, haversine

__version__ = "0.1.0"

__all__ = [
    "DEFAULTS", "PulseError", "analyze", "daily_loads", "decode_fit", "explain",
    "generate_example", "haversine", "load_series", "parse_daily_csv", "parse_gpx", "parse_tcx",
    "read_health", "readiness", "rmssd", "settings_with",
]
