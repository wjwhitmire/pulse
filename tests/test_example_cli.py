import json

import pytest

from fitenc import sample_activity
from healthgen import export_xml, export_zip
from pulse import analyze, generate_example, settings_with
from pulse.cli import main
from pulse.example import mulberry32
from pulse.util import parse_day

END = parse_day("2026-10-21")


def test_mulberry32_reference_values():
    r = mulberry32(1)
    # reference values of the public mulberry32 algorithm for seed 1
    assert [round(r(), 10) for _ in range(3)] == [0.6270739406, 0.0027357212, 0.52744704]


def test_example_is_deterministic_and_synthetic():
    a1, d1 = generate_example(END, days=21)
    a2, d2 = generate_example(END, days=21)
    assert [a["t"][-1] for a in a1] == [a["t"][-1] for a in a2] and d1 == d2
    assert len(d1) == 21 and d1[-1]["date"] == END
    for a in a1:
        assert a["source"] == "example"
        lats = [x for x in a["lat"] if x is not None]
        lons = [x for x in a["lon"] if x is not None]
        # the course is open ocean, far from any coast
        assert 40.85 < min(lats) and max(lats) < 41.15 and -40.25 < min(lons) and max(lons) < -39.85


def test_example_populates_every_view():
    acts, daily = generate_example(END)
    s = settings_with(None)
    runs = [analyze(a, s) for a in acts if a["sport"] == "run"]
    rides = [analyze(a, s) for a in acts if a["sport"] == "ride"]
    assert len(runs) > 30 and len(rides) > 15
    assert all(r["hr"] and r["load"] > 0 for r in runs + rides)
    assert all(r["power"] and r["power"]["weighted"] for r in rides)
    assert any(r["moving"] < r["elapsed"] for r in runs)  # some runs include a stop
    assert sum(1 for d in daily if d["rmssd"]) > 70


def test_cli_activity_load_readiness_example(tmp_path, capsys):
    data, _ = sample_activity(n=400)
    f = tmp_path / "run.fit"
    f.write_bytes(data)
    assert main(["activity", str(f)]) == 0
    out = capsys.readouterr().out
    assert "run.fit: run" in out and "fastest 400 m" in out
    assert main(["activity", str(f), "--json", "--units", "mi"]) == 0
    assert json.loads(capsys.readouterr().out)[0]["distance"] > 1000
    assert main(["load", str(f)]) == 0
    assert capsys.readouterr().out.startswith("date,load,fitness,fatigue,form")
    z = tmp_path / "export.zip"
    z.write_bytes(export_zip(export_xml(3)))
    assert main(["readiness", str(z)]) == 0
    assert "sleep was 7.7 h of a 7.4 h need" in capsys.readouterr().out
    c = tmp_path / "d.csv"
    c.write_text("date,hrv_ms,resting_hr,sleep_hours\n" + "".join(
        f"2026-01-{k:02d},{50 + k % 3},{48 + k % 2},7.5\n" for k in range(1, 31)))
    assert main(["readiness", str(c), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["state"] in ("clear", "one_off", "several_off")
    assert main(["example", "--end", "2026-10-21"]) == 0
    assert "synthetic" in capsys.readouterr().out


def test_cli_errors(tmp_path, capsys):
    bad = tmp_path / "x.gpx"
    bad.write_text('<!DOCTYPE x [<!ENTITY a "b">]><gpx/>')
    assert main(["activity", str(bad)]) == 2
    assert "DOCTYPE" in capsys.readouterr().err
    other = tmp_path / "x.kml"
    other.write_text("<kml/>")
    assert main(["activity", str(other)]) == 2
    assert main(["activity", str(tmp_path / "missing.fit")]) == 2
    with pytest.raises(SystemExit):
        main(["nonsense"])
