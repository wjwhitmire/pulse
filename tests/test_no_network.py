"""With every network switch off, the Pages build makes no network requests: open it in headless
Chromium, visit every view, import a GPX, a FIT, an Apple Health zip and a daily CSV, and record
every request that is not file:, data: or blob:. Skipped when Playwright or Chromium is missing."""

import os
import re
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
pw = pytest.importorskip("playwright.sync_api")

VIEWS = ["today", "log", "log/strength", "log/journal", "log/goals", "record", "trends", "body", "body/ready", "body/log", "body/health", "settings"]


def _page_html(tmp):
    src = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
    # A file:// copy with the CSP meta removed; test_csp_build_served_over_http covers the real CSP.
    src = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', "", src)
    src = src.replace("<head>", f'<head><base href="{(ROOT / "docs").as_uri()}/">', 1)
    p = tmp / "page.html"
    p.write_text(src, encoding="utf-8")
    return p


def test_zero_requests_with_switches_off(tmp_path):
    from fitenc import sample_activity
    from healthgen import export_xml, export_zip
    from test_gpx import GPX
    (tmp_path / "a.gpx").write_text(GPX)
    (tmp_path / "b.fit").write_bytes(sample_activity(n=300)[0])
    (tmp_path / "export.zip").write_bytes(export_zip(export_xml(3)))
    (tmp_path / "daily.csv").write_text("date,hrv_ms,resting_hr,sleep_hours\n2026-02-01,55,48,7.5\n")
    import gzip
    with zipfile.ZipFile(tmp_path / "strava.zip", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("activities.csv", "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Activity Gear,Distance\n"
                   "1,\"Mar 2, 2026, 7:00:00 AM\",Strava run,Run,120,0.3,activities/1.fit.gz,Trail shoe,300.0\n"
                   "2,\"Mar 3, 2026, 7:00:00 AM\",Swim,Swim,1800,1.5,,,1500.0\n")
        z.writestr("activities/1.fit.gz", gzip.compress(sample_activity(n=200, start=1772434800.0)[0]))
    (tmp_path / "workouts.csv").write_text("Workout start time,Workout end time,Duration (min),Activity name,Average HR (bpm)\n2026-03-05 07:00:00,,40,Running,150\n")
    (tmp_path / "physiological_cycles.csv").write_text("Cycle start time,Resting heart rate (bpm),Heart rate variability (ms),Wake onset,Asleep duration (min)\n2026-03-04 22:00:00,50,60,2026-03-05 06:30:00,450\n")
    page_file = _page_html(tmp_path)
    requests = []
    if True:
        with pw.sync_playwright() as p:
            try:
                b = p.chromium.launch()
            except Exception as e:  # browser not installed
                pytest.skip(f"chromium not available: {e}")
            pg = b.new_page()
            pg.on("request", lambda r: requests.append(r.url) if not r.url.startswith(("file:", "data:", "blob:")) else None)
            pg.goto(page_file.as_uri() + "#today")
            pg.wait_for_selector("#ready-count:not(:empty)", timeout=60000)
            for v in VIEWS:
                pg.evaluate(f"location.hash = '#{v}'")
                pg.wait_for_timeout(400)
            pg.evaluate("location.hash = '#settings'")
            pg.wait_for_timeout(300)
            pg.set_input_files("#in-acts", [str(tmp_path / "a.gpx"), str(tmp_path / "b.fit")])
            pg.wait_for_function("() => document.getElementById('import-log').textContent.includes('Activities:')", timeout=30000)
            pg.set_input_files("#in-health", str(tmp_path / "export.zip"))
            pg.wait_for_function("() => document.getElementById('import-log').textContent.includes('Apple Health')", timeout=30000)
            pg.set_input_files("#in-daily", str(tmp_path / "daily.csv"))
            pg.wait_for_timeout(800)
            pg.set_input_files("#in-strava", str(tmp_path / "strava.zip"))
            pg.wait_for_function("() => document.getElementById('import-log').textContent.includes('Strava:')", timeout=30000)
            pg.set_input_files("#in-whoop", [str(tmp_path / "workouts.csv"), str(tmp_path / "physiological_cycles.csv")])
            pg.wait_for_function("() => document.getElementById('import-log').textContent.includes('Whoop:')", timeout=30000)
            log = pg.inner_text("#import-log")
            for v in VIEWS:
                pg.evaluate(f"location.hash = '#{v}'")
                pg.wait_for_timeout(300)
            b.close()
    assert "2 added" in log, log
    assert "Strava: 1 activities with files, 1 without" in log, log
    assert "Whoop: 1 days of measurements, 1 workouts" in log, log
    assert "Apple Health: 31 records read" in log and "0 could not be read" in log, log
    assert requests == [], requests


def test_csp_build_served_over_http(tmp_path):
    """Review addition: the Pages build with its real Content-Security-Policy, served over http.
    The page must work under the CSP (no violations, imports run in the worker), make no request
    beyond its own origin, keep network switches off when a backup tries to turn them on, and
    write safe names into export zips."""
    import functools
    import http.server
    import json
    import threading
    from fitenc import sample_activity
    from test_gpx import GPX
    html = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
    csp = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', html).group(1)
    script_src = re.search(r"script-src ([^;]+)", csp).group(1)
    connect_src = re.search(r"connect-src ([^;]+)", csp).group(1).split()
    assert "'unsafe-inline'" not in script_src and "'unsafe-eval'" not in script_src
    # https and this computer only; the network gate picks the exact address (see SECURITY.md)
    assert connect_src == ["'self'", "https:", "http://localhost:*", "http://127.0.0.1:*"], connect_src
    (tmp_path / "a.gpx").write_text(GPX)
    (tmp_path / "b.fit").write_bytes(sample_activity(n=300)[0])
    backup = {"format": "pulse-backup", "version": 1, "activities": [], "daily": [],
              "kv": {"net": {"maps": True, "routing": True, "ai-cloud": True, "aiBase": "https://ai.example.org/v1", "aiModel": "m"}, "goals": []}}
    (tmp_path / "evil-backup.json").write_text(json.dumps(backup))
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "docs"))
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    origin = f"http://127.0.0.1:{srv.server_address[1]}"
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    outside, problems = [], []
    try:
        with pw.sync_playwright() as p:
            try:
                b = p.chromium.launch()
            except Exception as e:  # browser not installed
                pytest.skip(f"chromium not available: {e}")
            pg = b.new_page()
            pg.on("request", lambda r: outside.append(r.url) if not r.url.startswith((origin, "data:", "blob:")) else None)
            pg.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: problems.append(str(e)))
            pg.goto(origin + "/index.html#today")
            pg.wait_for_selector("#ready-count:not(:empty)", timeout=60000)
            for v in VIEWS:
                pg.evaluate(f"location.hash = '#{v}'")
                pg.wait_for_timeout(250)
            pg.set_input_files("#in-acts", [str(tmp_path / "a.gpx"), str(tmp_path / "b.fit")])
            pg.wait_for_function("() => document.getElementById('import-log').textContent.includes('Activities:')", timeout=30000)
            pg.set_input_files("#in-backup", str(tmp_path / "evil-backup.json"))
            pg.wait_for_function("() => document.getElementById('import-log').textContent.includes('Backup restored')", timeout=30000)
            switches = pg.evaluate("JSON.stringify(APP.kv.net)")
            names = pg.evaluate("['../../etc/passwd', 'gpx/2026_a1/../../x.gpx', '..', 'originals/résumé run.fit'].map(safeZipName)")
            log = pg.inner_text("#import-log")
            b.close()
    finally:
        srv.shutdown()
    assert "2 added" in log, log
    assert json.loads(switches) == {}, switches
    assert names == ["etc/passwd", "gpx/2026_a1/x.gpx", "file", "originals/r_sum__run.fit"], names
    assert outside == [], outside
    assert problems == [], problems
