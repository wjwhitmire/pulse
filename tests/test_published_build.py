"""The published form of Pulse, driven end to end in headless Chromium.

The Pages build (docs/) is copied with the release fill applied (https://wjwhitmire.github.io/pulse/, wjwhitmire and
https://github.com/wjwhitmire/pulse replaced, as the release script does) and served under /pulse/ on localhost with its real
Content-Security-Policy, the way GitHub Pages serves it. The main workflows run against that copy:
one import for every file type, settings read from the data, records, the clinician report (text,
FHIR and PDF), the calendar file, exports, recording with a mocked GPS and Bluetooth strap, every
network switch (off by default, refusals, inline turn-on, routing and coach with mocked hosts),
offline start from the service worker, and a phone-width pass. Skipped when Playwright or Chromium
is missing."""

import functools
import gzip
import http.server
import io
import json
import math
import re
import shutil
import threading
import xml.etree.ElementTree as ET
import zipfile
import zlib
import base64
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
pw = pytest.importorskip("playwright.sync_api")

from fitenc import sample_activity  # noqa: E402
from healthgen import export_xml  # noqa: E402

FILL = {"https://wjwhitmire.github.io/pulse/": "https://wjwhitmire.github.io/pulse/", "wjwhitmire": "wjwhitmire",
        "https://github.com/wjwhitmire/pulse": "https://github.com/wjwhitmire/pulse"}
VIEWS = ["today", "log", "log/strength", "log/journal", "log/goals", "record", "trends", "body", "body/ready",
         "body/log", "body/health", "settings"]

MOCKS = """(() => {
  try { delete window.showSaveFilePicker; } catch (e) {} window.showSaveFilePicker = undefined;
  window.__ble = {};
  const mk = (service) => { const ls = []; const ch = { addEventListener: (t, f) => ls.push(f), startNotifications: async () => ch };
    window.__ble[service] = { emit: (b) => { const dv = new DataView(new Uint8Array(b).buffer); for (const f of ls) f({ target: { value: dv } }); } };
    return { gatt: { connect: async () => ({ getPrimaryService: async () => ({ getCharacteristic: async () => ch }) }) } }; };
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async (o) => mk(o.filters[0].services[0]) }, configurable: true });
  const w = new Map(); let id = 0;
  window.__geo = (f) => { for (const cb of w.values()) cb({ timestamp: f.t, coords: { latitude: f.lat, longitude: f.lon, accuracy: 5, altitude: null } }); };
  Object.defineProperty(navigator, 'geolocation', { value: { watchPosition: (ok) => { w.set(++id, ok); return id; }, clearWatch: (i) => w.delete(i), getCurrentPosition: () => {} }, configurable: true });
  window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
})();"""


# ---------------------------------------------------------------- synthetic files (no real person or place)
def iso(t):
    import datetime
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def gpx(start, n=900, lat0=41.0, name="Synthetic run"):
    pts = "".join(f'<trkpt lat="{lat0 + i * 3.0 / 111195:.7f}" lon="-40.0"><ele>{50 + i * 0.01:.1f}</ele><time>{iso(start + i)}</time>'
                  f'<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>{140 + i % 20}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>'
                  for i in range(n))
    return ('<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1" '
            'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><name>' + name + '</name><type>running</type><trkseg>'
            + pts + "</trkseg></trk></gpx>")


def ecg_csv(bpm=60, secs=20, fs=512):
    rows = []
    for i in range(fs * secs):
        ph = (i / fs * bpm / 60.0) % 1.0
        rows.append(f"{1000 * math.exp(-((ph - 0.3) / 0.012) ** 2) + 200 * math.exp(-((ph - 0.55) / 0.04) ** 2):.2f}")
    return ("Name,Synthetic\nRecorded Date,2026-02-10 08:00:00 -0500\nClassification,Sinus Rhythm\nSample Rate,512 hertz\nLead,Lead I\nUnit,µV\n\n"
            + "\n".join(rows) + "\n")


def health_zip():
    xml = export_xml(3)
    import datetime
    extra = []
    today = datetime.date.today()
    for k in range(30):
        d = (today - datetime.timedelta(days=30 - k)).isoformat()
        extra.append(f'<Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="W" unit="count/min" startDate="{d} 06:00:00 -0500" endDate="{d} 06:00:00 -0500" value="{55 + k % 3}"/>\n')
        extra.append(f'<Record type="HKQuantityTypeIdentifierBodyMass" sourceName="S" unit="kg" startDate="{d} 07:00:00 -0500" endDate="{d} 07:00:00 -0500" value="70.2"/>\n')
    xml = xml.replace("</HealthData>", "".join(extra) + "</HealthData>")
    obs = {"resourceType": "Observation", "status": "final", "code": {"coding": [{"system": "http://loinc.org", "code": "2160-0", "display": "Creatinine"}]},
           "effectiveDateTime": "2026-02-10", "valueQuantity": {"value": 0.9, "unit": "mg/dL"},
           "referenceRange": [{"low": {"value": 0.7, "unit": "mg/dL"}, "high": {"value": 1.3, "unit": "mg/dL"}}]}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("apple_health_export/export.xml", xml)
        z.writestr("apple_health_export/clinical-records/Observation-1.json", json.dumps(obs))
        z.writestr("apple_health_export/electrocardiograms/ecg_1.csv", ecg_csv())
    return buf.getvalue()


def strava_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("activities.csv", "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Activity Gear,Distance\n"
                   '1,"Oct 1, 2026, 7:00:00 AM",Strava ride,Ride,600,3.0,activities/1.fit.gz,Road bike Y,3000.0\n'
                   '2,"Oct 2, 2026, 7:00:00 AM",Pool swim,Swim,1800,1.5,,,1500.0\n')
        z.writestr("activities/1.fit.gz", gzip.compress(sample_activity(n=300, start=1790838000.0, sport=2)[0]))
    return buf.getvalue()


def smart_card_qr():
    bundle = {"resourceType": "Bundle", "type": "collection", "entry": [{"resource": {"resourceType": "Immunization", "status": "completed",
              "vaccineCode": {"text": "Example vaccine"}, "occurrenceDateTime": "2025-01-01"}}]}
    payload = json.dumps({"iss": "https://issuer.example", "vc": {"credentialSubject": {"fhirBundle": bundle}}}).encode()
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    raw = co.compress(payload) + co.flush()
    b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")  # noqa: E731
    jws = b64(b'{"zip":"DEF","alg":"ES256"}') + "." + b64(raw) + "." + b64(b"x")
    return "shc:/" + "".join(f"{ord(c) - 45:02d}" for c in jws)


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("published")
    site_root = tmp / "www"
    shutil.copytree(ROOT / "docs", site_root / "pulse")
    for p in (site_root / "pulse").rglob("*"):
        if p.is_file() and p.suffix in (".html", ".js", ".webmanifest", ".svg", ".json", ".md"):
            t = p.read_text(encoding="utf-8")
            for k, v in FILL.items():
                t = t.replace(k, v)
            p.write_text(t, encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    for k, v in FILL.items():
        readme = readme.replace(k, v)
    assert "{{" not in readme
    files = tmp / "files"
    files.mkdir()
    (files / "run.gpx").write_text(gpx(1790000000))
    (files / "run.fit").write_bytes(sample_activity(n=600, start=1790100000.0)[0])
    (files / "export.zip").write_bytes(health_zip())
    (files / "strava.zip").write_bytes(strava_zip())
    (files / "physiological_cycles.csv").write_text("Cycle start time,Resting heart rate (bpm),Heart rate variability (ms),Wake onset,Asleep duration (min)\n"
                                                     "2026-09-04 22:00:00,50,60,2026-09-05 06:30:00,450\n2026-09-05 22:00:00,-5,0,2026-09-06 06:30:00,440\n")
    (files / "workouts.csv").write_text("Workout start time,Workout end time,Duration (min),Activity name,Average HR (bpm)\n2026-09-05 07:00:00,,40,Running,150\n")
    (files / "daily.csv").write_text("date,hrv_ms,resting_hr,sleep_hours\n2026-08-01,55,48,7.5\n2026-08-02,57,49,7.0\n")
    (files / "card.txt").write_text(smart_card_qr())
    (files / "ecg.csv").write_text(ecg_csv(bpm=75))
    (files / "notes.txt").write_text("hello")

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(site_root)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with pw.sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as e:  # browser not installed
            srv.shutdown()
            pytest.skip(f"chromium not available: {e}")
        yield {"url": f"http://127.0.0.1:{srv.server_address[1]}/pulse/", "origin": f"http://127.0.0.1:{srv.server_address[1]}",
               "files": files, "browser": browser, "tmp": tmp}
        browser.close()
    srv.shutdown()


class Page:
    def __init__(self, site, width=1280, touch=False, route=None):
        self.ctx = site["browser"].new_context(viewport={"width": width, "height": 900}, has_touch=touch, is_mobile=touch,
                                               accept_downloads=True, locale="en-US")
        self.ctx.add_init_script(MOCKS)
        self.errors, self.outside, self.origin = [], [], site["origin"]
        if route:
            self.ctx.route("https://**/*", route)
        self.pg = self.ctx.new_page()
        self.pg.on("pageerror", lambda e: self.errors.append(str(e)))
        self.pg.on("console", lambda m: self.errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
        self.pg.on("request", lambda r: self.outside.append(r.url) if not r.url.startswith((self.origin, "data:", "blob:")) else None)
        self.pg.goto(site["url"] + "#today")
        self.ready()
        self.files = site["files"]
        self.out = site["tmp"]

    def ready(self):
        self.pg.wait_for_function("() => typeof APP !== 'undefined' && APP.ready === true", timeout=60000)

    def go(self, h, ms=300):
        self.pg.evaluate("(h) => { location.hash = '#' + h; }", h)
        self.pg.wait_for_timeout(ms)

    def log(self):
        return self.pg.inner_text("#import-log")

    def wait_log(self, text, timeout=60000):
        self.pg.wait_for_function("(t) => document.getElementById('import-log').textContent.includes(t)", arg=text, timeout=timeout)

    def download(self, click):
        with self.pg.expect_download(timeout=30000) as d:
            click()
        path = self.out / d.value.suggested_filename
        d.value.save_as(path)
        return path

    def csp(self):
        return self.pg.evaluate("window.__csp")

    def close(self):
        self.ctx.close()


def test_boot_views_and_phone_width(site):
    for width, touch in ((1280, False), (400, True)):
        P = Page(site, width, touch)
        for v in VIEWS:
            P.go(v, 250)
            assert "went wrong" not in P.pg.inner_text("#status"), v
            assert P.pg.evaluate("document.scrollingElement.scrollWidth - innerWidth") <= 0, (v, width)
        if touch:
            # phone calendar is an agenda: every control there is at least 44 px tall and wide
            P.go("log", 400)
            sizes = P.pg.evaluate("[...document.querySelectorAll('#calendar button')].map(b => { const r = b.getBoundingClientRect(); return [r.width, r.height]; })")
            assert P.pg.evaluate("$('calendar').className") == "agenda" and sizes and all(w >= 44 and h >= 44 for w, h in sizes), sizes
        first = P.pg.evaluate("metaList()[0].id")
        P.go("log/" + first, 800)
        assert not P.pg.evaluate("$('act-detail').hidden")
        assert P.errors == [] and P.csp() == [] and P.outside == [], (P.errors, P.csp(), P.outside)
        P.close()


def test_one_import_for_every_file_and_settings_from_data(site):
    P = Page(site)
    F = P.files
    P.go("settings")
    P.pg.set_input_files("#in-any", [str(F / n) for n in ("run.gpx", "run.fit", "export.zip", "strava.zip", "physiological_cycles.csv",
                                                           "workouts.csv", "daily.csv", "card.txt", "ecg.csv", "notes.txt")])
    P.wait_log("Daily CSV:")
    P.pg.wait_for_function("() => $('progress').hidden", timeout=60000)
    P.pg.wait_for_timeout(1000)
    log = P.log()
    assert "Recognised:" in log and "1 not recognised" in log, log
    assert "notes.txt: Pulse does not recognise this file" in log
    assert "Activities: 2 added" in log, log
    assert "Apple Health:" in log and "Apple Health ECGs: 1" in log, log
    assert "Strava: 1 activities with files, 1 without" in log, log
    assert "Whoop: 2 days of measurements, 1 workouts" in log, log
    assert "Health records: 1 of 1 file read" in log and "ECG: 1 of 1 recording read" in log, log
    # Whoop row with impossible values is dropped, not imported
    bad = P.pg.evaluate("JSON.stringify(APP.daily.get(SB.parseDay('2026-09-06')))")
    assert '"rhr":null' in bad and '"rmssd":null' in bad, bad
    # Strava gear on a ride is a bike
    assert P.pg.evaluate("APP.kv.gear.find(g => g.name === 'Road bike Y').kind") == "bike"
    # resting HR read from the imported data, with the reason shown in Settings
    auto = P.pg.evaluate("JSON.stringify(APP.kv.auto)")
    assert "rest_hr" in auto and "units" in auto, auto
    P.go("settings", 400)
    note = P.pg.text_content("#auto-note")
    assert "Set from your data" in note and "Resting heart rate" in note and "Change" in note, note
    assert P.pg.evaluate("APP.settings.units") == "mi"  # en-US region
    # a value the person types is theirs and is not replaced by the next import
    P.pg.fill("#set-rest_hr", "47")
    P.pg.click("#settings-save")
    P.pg.wait_for_function("() => $('progress').hidden && $('status').textContent.includes('Settings saved')", timeout=30000)
    P.pg.set_input_files("#in-daily", str(F / "daily.csv"))
    P.wait_log("Daily CSV: 2 days")
    P.pg.wait_for_timeout(500)
    assert P.pg.evaluate("APP.settings.rest_hr") == 47
    # records: ECG heart rate, SMART card from QR text, duplicates kept once
    P.go("body/health", 800)
    health = P.pg.inner_text("#health-root")
    assert "Example vaccine" in health and "Creatinine" in health, health
    assert re.search(r"Heart rate from detected beats: (60|75) bpm", health), health
    P.pg.set_input_files("#in-fhir", str(F / "card.txt"))
    P.pg.wait_for_timeout(600)
    assert P.pg.evaluate("APP.kv.medical.length") == 2
    assert "already imported" in P.log()
    assert P.errors == [] and P.csp() == [] and P.outside == [], (P.errors, P.csp(), P.outside)
    P.close()


def test_entries_example_report_calendar_and_exports(site):
    P = Page(site)
    assert P.pg.evaluate("APP.example") is True
    # the first entry made over the example starts the person's own log and is kept
    P.go("log/strength", 400)
    ins = P.pg.query_selector_all("#st-sets tbody input")
    ins[0].fill("Back squat"); ins[1].fill("5"); ins[2].fill("100")
    assert P.pg.input_value("#st-unit") == "lb"  # miles region: pounds by default
    P.pg.select_option("#st-unit", "kg")
    P.pg.click("#st-save")
    P.pg.wait_for_function("() => APP.example === false && APP.kv.strength.length === 1", timeout=10000)
    assert "Started your own log" in P.log()
    P.pg.reload(); P.ready()
    assert P.pg.evaluate("APP.kv.strength.length") == 1 and P.pg.evaluate("APP.example") is False
    # goals are typed and shown in the chosen units (miles here)
    P.go("log/goals", 300)
    assert P.pg.text_content("#gl-metric option[value=distance]") == "Distance (mi)"
    P.pg.select_option("#gl-metric", "distance"); P.pg.fill("#gl-target", "10"); P.pg.click("#gl-save"); P.pg.wait_for_timeout(300)
    assert abs(P.pg.evaluate("APP.kv.goals[0].target") - 16093.44) < 1e-6
    assert " mi of 10" in P.pg.inner_text("#gl-list")
    # body log refuses an inverted blood pressure, keeps a good one
    P.go("body/log", 300)
    P.pg.fill("#bd-sys", "80"); P.pg.fill("#bd-dia", "120"); P.pg.click("#bd-save"); P.pg.wait_for_timeout(200)
    assert "systolic" in P.pg.inner_text("#status")
    P.pg.fill("#bd-sys", "121"); P.pg.fill("#bd-dia", "79"); P.pg.fill("#bd-kg", "70.4"); P.pg.click("#bd-save"); P.pg.wait_for_timeout(300)
    assert P.pg.evaluate("APP.kv.body.length") == 1
    P.pg.wait_for_function("() => APP.settings.weight_kg === 70.4", timeout=10000)  # weight for energy read from the body log
    P.go("settings")
    P.pg.set_input_files("#in-any", str(P.files / "daily.csv"))
    P.wait_log("Daily CSV")
    # clinician report: text, FHIR bundle, and a PDF from the print view
    P.go("body/health", 600)
    P.pg.click("text=Build report")
    text = P.pg.input_value("#report-out")
    assert "Resting heart rate" in text or "Heart rate variability" in text, text
    b = json.loads(P.download(lambda: P.pg.click("text=Save as FHIR bundle")).read_text())
    assert b["resourceType"] == "Bundle" and b["type"] == "collection" and any(e["resource"]["resourceType"] == "Observation" for e in b["entry"])
    P.pg.evaluate("window.print = () => {}")
    P.pg.click("#report-print")
    assert P.pg.evaluate("document.body.classList.contains('printing')")
    pdf = P.pg.pdf()
    assert pdf[:5] == b"%PDF-"
    try:
        import pypdf
        txt = "".join(pg.extract_text() for pg in pypdf.PdfReader(io.BytesIO(pdf)).pages)
        assert "Self-recorded health summary" in txt and "Training load" not in txt, txt[:300]
    except ImportError:
        pass
    P.pg.evaluate("window.dispatchEvent(new Event('afterprint'))")
    # bedtime calendar file
    P.go("today", 400)
    ics = P.download(lambda: P.pg.click("#plan-ics-file")).read_bytes()
    assert ics.startswith(b"BEGIN:VCALENDAR\r\n") and ics.count(b"BEGIN:VEVENT") == 2 and ics.rstrip().endswith(b"END:VCALENDAR")
    assert all(len(line) <= 75 for line in ics.split(b"\r\n"))
    # exports open and hold the right things
    P.go("settings", 300)
    j = json.loads(P.download(lambda: P.pg.click("#ex-json")).read_text())
    assert j["format"] == "pulse-backup" and len(j["kv"]["strength"]) == 1
    z = zipfile.ZipFile(P.download(lambda: P.pg.click("#ex-zip")))
    assert z.testzip() is None and {"pulse-backup.json", "activities.csv", "daily.csv"} <= set(z.namelist())
    assert z.read("daily.csv").decode().startswith("date,rmssd_ms")
    # a damaged backup keeps every section in the shape Pulse expects
    evil = P.out / "evil.json"
    evil.write_text(json.dumps({"format": "pulse-backup", "version": 1, "activities": [{"id": "x", "start": "no"}, None],
                                "daily": [{"date": "x"}], "kv": {"goals": "not a list", "net": {"maps": True}}}))
    P.pg.set_input_files("#in-backup", str(evil))
    P.wait_log("Backup restored")
    assert "damaged entries skipped" in P.log()
    assert P.pg.evaluate("Array.isArray(APP.kv.goals) && JSON.stringify(APP.kv.net)") == "{}"
    for v in VIEWS:
        P.go(v, 200)
        assert "went wrong" not in P.pg.inner_text("#status"), v
    assert P.errors == [] and P.csp() == [] and P.outside == [], (P.errors, P.csp(), P.outside)
    P.close()


def test_recording_strap_and_cuff(site):
    P = Page(site, 400, True)
    P.go("record", 400)
    P.pg.click("text=Connect a heart rate strap")
    P.pg.click("text=Start reading")
    for i in range(60):
        u = round((1000 if i % 2 else 1040) * 1024 / 1000)
        P.pg.evaluate("(b) => __ble[0x180D].emit(b)", [0x10, 60, u & 255, u >> 8])
    assert P.pg.inner_text("#hrv-live-val") == "40"
    P.pg.click("#rec-main")
    lat, chip = 41.5, None
    for s in range(400):
        if not 200 <= s < 260:
            lat += 3.0 / 111195.0
        P.pg.evaluate("(f) => __geo(f)", {"t": 1_800_000_000_000 + s * 1000, "lat": lat, "lon": -40.0})
        if s == 100:
            P.pg.click("#rec-lap")
        if s == 240:
            chip = P.pg.inner_text("#rec-chip")
    assert chip == "Auto-paused"
    v = P.pg.evaluate("PulseRecord.view(REC.state)")
    assert abs(v["distance"] - 340 * 3) < 40 and abs(v["movingTime"] / 1000 - 340) < 10, v
    box = P.pg.locator("#rec-finish").bounding_box()
    P.pg.mouse.move(box["x"] + 5, box["y"] + 5); P.pg.mouse.down(); P.pg.wait_for_timeout(1300); P.pg.mouse.up()
    P.pg.wait_for_function("() => location.hash.startsWith('#log/a')", timeout=10000)
    laps = P.pg.evaluate("APP.meta.get(location.hash.split('/')[1]).an.lap_table.length")
    assert laps == 2  # the stretch after the lap press is the final lap
    P.go("body/health", 500)
    P.pg.click("text=Connect a cuff")
    P.pg.wait_for_timeout(200)
    P.pg.evaluate("(b) => __ble[0x1810].emit(b)", [0x04, 120, 0, 80, 0, 93, 0, 64, 0])
    P.pg.wait_for_timeout(400)
    assert "120/80" in P.pg.inner_text("#status")
    assert P.errors == [] and P.csp() == [] and P.outside == [], (P.errors, P.csp(), P.outside)
    P.close()


def test_network_switches_refusals_routing_and_coach(site):
    over = (ROOT / "web" / "lib" / "test" / "fixtures" / "overpass_small.json").read_text()
    hits, ai_reqs = [], []
    HOSTED, LOCAL = "https://ai.example.org/v1", "http://localhost:11434/v1"

    def fake(route):
        u = route.request.url
        hits.append(u)
        cors = {"content-type": "application/json", "access-control-allow-origin": "*"}
        if u.startswith("https://overpass-api.de/"):
            return route.fulfill(status=200, body=over, headers=cors)
        if u in (HOSTED + "/chat/completions", LOCAL + "/chat/completions"):
            if route.request.method == "OPTIONS":
                return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST"})
            ai_reqs.append((u, route.request.headers, json.loads(route.request.post_data)))
            return route.fulfill(status=200, body=json.dumps({"choices": [{"message": {"content": "Load <b>fine</b>, see https://x.example"}}]}), headers=cors)
        return route.fulfill(status=404, body="")
    P = Page(site, route=fake)
    P.ctx.route("http://localhost:11434/**", fake)
    assert P.pg.evaluate("JSON.stringify(APP.kv.net)") == "{}"
    P.go("settings", 300)
    assert not any(P.pg.is_checked("#net-" + k) for k in ("maps", "routing", "ai-local", "ai-cloud"))
    refusals = P.pg.evaluate("""async () => { const out = [];
      for (const [f, u] of [['routing', 'https://overpass-api.de/api/interpreter'], ['ai-cloud', 'https://ai.example.org/v1/chat/completions'],
                            ['maps', 'https://tiles.openfreemap.org/x'], ['nope', 'https://overpass-api.de/']]) {
        try { await net(f, u); out.push('allowed'); } catch (e) { out.push(e.message); } }
      try { await netScript('maps', MAPLIBRE.js, MAPLIBRE.jsSri); out.push('allowed'); } catch (e) { out.push(e.message); }
      try { await netImport('ai-local', WEBLLM); out.push('allowed'); } catch (e) { out.push(e.message); }
      return out; }""")
    assert all(r.startswith("Blocked:") for r in refusals), refusals
    assert hits == []
    # the planner's dead end is now its own switch, with the hosts named beside it
    P.go("record", 400)
    assert "overpass-api.de" in P.pg.inner_text("#plan-card")
    P.pg.click("#plan-enable")
    P.pg.wait_for_timeout(400)
    assert P.pg.evaluate("APP.kv.net.maps === true && APP.kv.net.routing === true")
    bad = P.pg.evaluate("""async () => { const out = [];
      for (const u of ['http://overpass-api.de/x', 'https://evil.example/x', 'https://overpass-api.de:8443/x', 'https://u:p@overpass-api.de/', 'https://overpass-api.de.evil.example/'])
        { try { await net('routing', u); out.push('allowed'); } catch (e) { out.push(e.message); } }
      return out; }""")
    assert all(r.startswith("Blocked:") and "Turn on" not in r for r in bad), bad
    P.go("record", 1200)
    res = P.pg.evaluate("""async () => {
      const click = (t) => [...document.querySelectorAll('#plan-card button')].find(b => b.textContent === t).click();
      const wait = () => new Promise(r => setTimeout(r, 800));
      PLAN.points = [[45.0, 7.0], [45.004, 7.004]]; click('Find route'); await wait();
      const a = [$('plan-info').textContent, PLAN.result && PLAN.result.distance];
      $('plan-loop').value = '1'; click('Suggest loops'); await wait();
      return [a, $('plan-info').textContent, PLAN.result && PLAN.result.distance];
    }""")
    assert res[0][0].startswith("Route:") and 700 < res[0][1] < 900, res
    assert res[1].startswith("Loop:") and 750 < res[2] < 1250, res
    gpx_path = P.download(lambda: P.pg.evaluate("[...document.querySelectorAll('#plan-card button')].find(b => b.textContent === 'Export GPX').click()"))
    assert len(ET.parse(gpx_path).getroot().findall(".//{http://www.topografix.com/GPX/1/1}trkpt")) >= 2
    # coach with your own AI service: inline turn-on, address and model typed on the card, a hosted
    # https service with a key, then a server on this computer with no key; the reply filtered
    P.go("today", 400)
    P.pg.click("#coach-enable-cloud")
    P.pg.wait_for_timeout(300)
    assert P.pg.text_content("#coach-pack").strip()  # the numbers that would be sent, shown before asking
    P.pg.fill("#coach-base", HOSTED)
    P.pg.fill("#coach-model", "small-model-1")
    P.pg.fill("#coach-q", "How was my week?")
    P.pg.fill("#coach-key", "key-0000000000000")
    P.pg.click("#today-coach button.primary")
    P.pg.wait_for_function("() => $('coach-log').textContent.includes('Coach')", timeout=10000)
    reply = P.pg.inner_text("#coach-log")
    assert "<b>" not in reply and "x.example" not in reply and "fine" in reply, reply
    url, headers, body = ai_reqs[-1]
    assert url == HOSTED + "/chat/completions" and headers.get("authorization") == "Bearer key-0000000000000"
    assert body["model"] == "small-model-1" and body["messages"][0]["role"] == "system" and body["messages"][-1]["content"] == "How was my week?"
    # only the configured address: another path or host on https is refused
    other = P.pg.evaluate("""async () => { const out = [];
      for (const u of ['https://ai.example.org/v1/models', 'https://evil.example/v1/chat/completions', 'http://ai.example.org/v1/chat/completions', 'http://localhost:11434/v1/chat/completions'])
        { try { await net('ai-cloud', u); out.push('allowed'); } catch (e) { out.push(e.message); } }
      return out; }""")
    assert all(r.startswith("Blocked:") for r in other), other
    # a model server on this computer: http to localhost, no key
    P.go("settings", 300)
    P.pg.fill("#net-ai-base", LOCAL)
    P.pg.dispatch_event("#net-ai-base", "change")
    P.pg.wait_for_timeout(200)
    assert "http://localhost:11434/v1/chat/completions" in P.pg.inner_text("#net-ai-note")
    P.go("today", 400)
    P.pg.fill("#coach-q", "And my sleep?")
    P.pg.click("#today-coach button.primary")
    P.pg.wait_for_function("(n) => $('coach-log').querySelectorAll('li').length >= n", arg=4, timeout=10000)
    P.pg.wait_for_timeout(200)
    url, headers, body = ai_reqs[-1]
    assert url == LOCAL + "/chat/completions" and "authorization" not in headers, headers
    # an http address elsewhere is refused before anything is sent
    P.go("settings", 300)
    P.pg.fill("#net-ai-base", "http://ai.example.org/v1")
    P.pg.dispatch_event("#net-ai-base", "change")
    P.pg.wait_for_timeout(200)
    assert "https" in P.pg.inner_text("#net-ai-note")
    P.pg.locator("#net-ai-cloud").uncheck(force=True)
    P.pg.wait_for_timeout(200)
    assert P.pg.evaluate("net('ai-cloud', 'https://ai.example.org/v1/chat/completions').then(() => 'allowed', (e) => e.message)").startswith("Blocked: switch off")
    assert set(h.split("/")[2] for h in hits) <= {"overpass-api.de", "ai.example.org", "localhost:11434", "cdnjs.cloudflare.com"}, hits
    assert P.errors == [] and P.csp() == [], (P.errors, P.csp())
    P.close()


def test_offline_start_from_the_service_worker(site):
    P = Page(site)
    P.pg.evaluate("navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready)")
    P.pg.wait_for_function("() => caches.keys().then(k => k.length === 1)", timeout=30000)
    P.ctx.set_offline(True)
    P.pg.reload()
    P.ready()
    assert P.pg.inner_text("#ready-count") not in ("", "-")
    P.go("trends", 400)
    assert P.pg.evaluate("$('view-trends').hidden") is False
    P.ctx.set_offline(False)
    assert [e for e in P.errors if "INTERNET_DISCONNECTED" not in e] == [] and P.csp() == []
    P.close()
