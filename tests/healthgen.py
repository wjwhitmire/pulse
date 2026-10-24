"""Builds a small synthetic Apple Health export (export.xml and export.zip) for tests."""

import io
import zipfile

HEAD = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ELEMENT HealthData (ExportDate,Me,(Record|Workout)*)>
<!ATTLIST Record type CDATA #REQUIRED>
<!ENTITY trap "SHOULD-NEVER-APPEAR">
]>
<HealthData locale="en_US">
 <ExportDate value="2026-03-01 08:00:00 -0500"/>
 <Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet"/>
"""


def beats(start_clock_s, rr_ms, ampm=True):
    """InstantaneousBeatsPerMinute children with clock times built from RR intervals."""
    out = []
    t = start_clock_s
    for r in [0.0] + list(rr_ms):
        t += r / 1000.0
        h = int(t // 3600) % 24
        m = int(t % 3600 // 60)
        s = t % 60
        if ampm:
            hh = h % 12 or 12
            txt = f"{hh}:{m:02d}:{s:05.2f} {'AM' if h < 12 else 'PM'}"
        else:
            txt = f"{h:02d}:{m:02d}:{s:05.2f}"
        out.append(f'<InstantaneousBeatsPerMinute bpm="{round(60000 / (r or 1000))}" time="{txt}"/>')
    return "".join(out)


RR_A = [1000, 1020, 990, 1010, 1000, 980, 1015, 1005, 995, 1010] * 3   # 30 intervals
RR_B = [900, 950, 880, 940, 890, 930, 900, 960, 870, 945] * 3


def export_xml(days=3):
    """Records for 2026-02-01 .. 2026-02-0N. Includes a decoy Record type, an escaped source
    name, a self-closing SDNN record, two sleep sources that overlap, and a nap."""
    rows = [HEAD]
    for k in range(days):
        d = f"2026-02-{k + 1:02d}"
        rows.append(f' <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" unit="count" '
                    f'startDate="{d} 07:00:00 -0500" endDate="{d} 07:10:00 -0500" value="900"/>\n')
        rows.append(f' <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Watch &amp; Co &trap;" '
                    f'unit="count/min" startDate="{d} 06:00:00 -0500" endDate="{d} 06:00:00 -0500" value="{50 + k}"/>\n')
        rr = RR_A if k % 2 == 0 else RR_B
        rows.append(f' <Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" sourceName="Watch" unit="ms" '
                    f'startDate="{d} 05:30:00 -0500" endDate="{d} 05:31:00 -0500" value="{40 + k}">\n'
                    f'  <HeartRateVariabilityMetadataList>{beats(5.5 * 3600, rr)}</HeartRateVariabilityMetadataList>\n'
                    f' </Record>\n')
        rows.append(f' <Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" sourceName="Watch" unit="ms" '
                    f'startDate="{d} 15:00:00 -0500" endDate="{d} 15:01:00 -0500" value="99"/>\n')
        prev = f"2026-01-{31:02d}" if k == 0 else f"2026-02-{k:02d}"
        # watch: 23:00 to 06:30 split in stages; phone: overlapping 22:50 to 05:50 'Asleep'
        rows.append(f' <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" '
                    f'startDate="{prev} 23:00:00 -0500" endDate="{d} 02:00:00 -0500" value="HKCategoryValueSleepAnalysisAsleepCore"/>\n')
        rows.append(f' <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" '
                    f'startDate="{d} 02:00:00 -0500" endDate="{d} 03:00:00 -0500" value="HKCategoryValueSleepAnalysisAsleepDeep"/>\n')
        rows.append(f' <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" '
                    f'startDate="{d} 03:00:00 -0500" endDate="{d} 03:20:00 -0500" value="HKCategoryValueSleepAnalysisAwake"/>\n')
        rows.append(f' <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" '
                    f'startDate="{d} 03:20:00 -0500" endDate="{d} 06:30:00 -0500" value="HKCategoryValueSleepAnalysisAsleepREM"/>\n')
        rows.append(f' <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Phone" '
                    f'startDate="{prev} 22:50:00 -0500" endDate="{d} 05:50:00 -0500" value="HKCategoryValueSleepAnalysisAsleepUnspecified"/>\n')
        rows.append(f' <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Phone" '
                    f'startDate="{prev} 22:00:00 -0500" endDate="{d} 06:40:00 -0500" value="HKCategoryValueSleepAnalysisInBed"/>\n')
        if k == 1:
            rows.append(f' <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" '
                        f'startDate="{d} 14:00:00 -0500" endDate="{d} 14:40:00 -0500" value="HKCategoryValueSleepAnalysisAsleepCore"/>\n')
    rows.append(' <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30"/>\n</HealthData>\n')
    return "".join(rows)


def export_zip(xml, method=zipfile.ZIP_DEFLATED, zip64=False):
    buf = io.BytesIO()
    old = zipfile.ZIP64_LIMIT
    if zip64:
        zipfile.ZIP64_LIMIT = 1  # forces ZIP64 extra fields and the ZIP64 end records
    try:
        with zipfile.ZipFile(buf, "w", compression=method) as zf:
            for name, data in (("apple_health_export/export_cda.xml", "<ClinicalDocument/>"),
                               ("apple_health_export/export.xml", xml),
                               ("apple_health_export/workout-routes/route_1.gpx", "<gpx/>")):
                # fixed timestamp so tests/vectors.json is byte-for-byte reproducible (CI diffs it)
                zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                zi.compress_type = method
                zf.writestr(zi, data)
    finally:
        zipfile.ZIP64_LIMIT = old
    return buf.getvalue()
