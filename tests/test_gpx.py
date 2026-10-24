import pytest

from pulse import PulseError, parse_gpx, parse_tcx

GPX = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata><name>Morning loop &amp; hills</name></metadata>
  <trk><type>running</type><trkseg>
    <trkpt lat="41.0000" lon="-40.0000"><ele>100.0</ele><time>2026-01-01T06:00:00Z</time>
      <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr><gpxtpx:cad>85</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="41.0001" lon="-40.0000"><ele>101.5</ele><time>2026-01-01T06:00:05Z</time>
      <extensions><power>250</power><gpxtpx:TrackPointExtension><gpxtpx:hr>125</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="41.0002" lon="-40.0000"><time>2026-01-01T06:00:10Z</time></trkpt>
    <trkpt lat="41.0003" lon="-40.0000"></trkpt>
  </trkseg></trk>
</gpx>"""

TCX = """<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
 <Activities><Activity Sport="Biking"><Id>2026-01-02T07:00:00Z</Id>
  <Lap StartTime="2026-01-02T07:00:00Z"><TotalTimeSeconds>10</TotalTimeSeconds><DistanceMeters>60</DistanceMeters>
   <AverageHeartRateBpm><Value>130</Value></AverageHeartRateBpm>
   <Track>
    <Trackpoint><Time>2026-01-02T07:00:00Z</Time><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>128</Value></HeartRateBpm>
      <Cadence>88</Cadence><Extensions><ns3:TPX><ns3:Watts>200</ns3:Watts></ns3:TPX></Extensions></Trackpoint>
    <Trackpoint><Time>2026-01-02T07:00:05Z</Time><Position><LatitudeDegrees>41.0</LatitudeDegrees><LongitudeDegrees>-40.0</LongitudeDegrees></Position>
      <AltitudeMeters>50</AltitudeMeters><DistanceMeters>30</DistanceMeters><HeartRateBpm><Value>131</Value></HeartRateBpm></Trackpoint>
    <Trackpoint><Time>2026-01-02T07:00:10Z</Time><DistanceMeters>60</DistanceMeters>
      <Extensions><ns3:TPX><ns3:RunCadence>90</ns3:RunCadence></ns3:TPX></Extensions></Trackpoint>
   </Track></Lap></Activity>
  <Activity Sport="Running"><Id>2026-01-03T07:00:00Z</Id><Lap StartTime="2026-01-03T07:00:00Z"><Track>
    <Trackpoint><Time>2026-01-03T07:00:00Z</Time></Trackpoint><Trackpoint><Time>2026-01-03T07:00:01Z</Time></Trackpoint>
  </Track></Lap></Activity>
 </Activities></TrainingCenterDatabase>"""


def test_gpx_points_extensions_and_name():
    (a,) = parse_gpx(GPX.encode())
    assert a["name"] == "Morning loop & hills" and a["sport"] == "run"
    assert a["t"] == [1767247200.0, 1767247205.0, 1767247210.0]
    assert a["lat"] == [41.0, 41.0001, 41.0002]
    assert a["ele"] == [100.0, 101.5, None]
    assert a["hr"] == [120.0, 125.0, None] and a["cad"] == [85.0, None, None]
    assert a["pwr"] == [None, 250.0, None]
    assert "points without a time were skipped" in a["warnings"]


def test_gpx_bom_and_str_input():
    (a,) = parse_gpx(b"\xef\xbb\xbf" + GPX.encode())
    assert len(a["t"]) == 3
    (b,) = parse_gpx(GPX)
    assert b["t"] == a["t"]


def test_tcx_activities_laps_and_extensions():
    acts = parse_tcx(TCX.encode())
    assert len(acts) == 2
    a = acts[0]
    assert a["sport"] == "ride" and acts[1]["sport"] == "run"
    assert a["dist"] == [0.0, 30.0, 60.0]
    assert a["lat"] == [None, 41.0, None]
    assert a["pwr"] == [200.0, None, None] and a["cad"] == [88.0, None, 90.0]
    assert a["hr"] == [128.0, 131.0, None]
    assert a["laps"][0]["distance"] == 60.0 and a["laps"][0]["avg_hr"] == 130.0


@pytest.mark.parametrize("doc", [
    '<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY a "aaaa">]><gpx>&a;</gpx>',
    '<?xml version="1.0"?><!doctype gpx SYSTEM "file:///etc/passwd"><gpx/>',
    '<?xml version="1.0"?>\n<!ENTITY x SYSTEM "http://example.invalid/x">',
])
def test_doctype_and_entities_refused(doc):
    with pytest.raises(PulseError) as e:
        parse_gpx(doc.encode())
    assert e.value.code == "doctype"


def test_billion_laughs_refused_before_parse():
    lol = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><gpx>&lol2;</gpx>'
    with pytest.raises(PulseError) as e:
        parse_tcx(lol.encode())
    assert e.value.code == "doctype"


@pytest.mark.parametrize("doc,code", [
    ("<gpx><trk><trkseg><trkpt lat='1' lon='2'></trkseg></trk></gpx>", "xml"),
    ("not xml at all", "xml"),
    ("<kml></kml>", "notgpx"),
    ("<gpx><trk><trkseg><trkpt lat='1' lon='2'><time>2026-01-01T00:00:00Z</time></trkpt></trkseg></trk></gpx>", "notimes"),
    ("<gpx>&undefined;</gpx>", "xml"),
])
def test_malformed_gpx(doc, code):
    with pytest.raises(PulseError) as e:
        parse_gpx(doc.encode())
    assert e.value.code == code


def test_malformed_tcx():
    with pytest.raises(PulseError) as e:
        parse_tcx(b"<gpx/>")
    assert e.value.code == "nottcx"
    with pytest.raises(PulseError) as e:
        parse_tcx(b"<TrainingCenterDatabase><Activities/></TrainingCenterDatabase>")
    assert e.value.code == "notimes"


def test_encoding_refusals():
    with pytest.raises(PulseError) as e:
        parse_gpx(GPX.encode("utf-16"))
    assert e.value.code == "encoding"
    with pytest.raises(PulseError) as e:
        parse_gpx(b"<gpx>\xff\xfe\xfa</gpx>")
    assert e.value.code == "encoding"


def test_bad_coordinates_and_backwards_time():
    doc = """<gpx><trk><trkseg>
      <trkpt lat="95" lon="10"><time>2026-01-01T00:00:00Z</time></trkpt>
      <trkpt lat="41" lon="-40"><time>2026-01-01T00:00:05Z</time></trkpt>
      <trkpt lat="41" lon="-40"><time>2026-01-01T00:00:03Z</time></trkpt>
      <trkpt lat="abc" lon="-40"><time>2026-01-01T00:00:09Z</time></trkpt>
    </trkseg></trk></gpx>"""
    (a,) = parse_gpx(doc.encode())
    assert a["lat"] == [None, 41.0, None] and a["lon"] == [None, -40.0, None]
    assert "points out of time order were skipped" in a["warnings"]


def test_size_limit(monkeypatch):
    import pulse.gpx as g
    monkeypatch.setattr(g, "MAX_BYTES", 100)
    with pytest.raises(PulseError) as e:
        parse_gpx(GPX.encode())
    assert e.value.code == "size"
