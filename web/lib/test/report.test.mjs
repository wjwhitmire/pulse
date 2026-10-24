import { test, load, throwsCode, assert, same, noEmDash } from "./harness.mjs";
const R = load("report.js", "PulseReport");
const F = load("fhir.js", "PulseFHIR");

function days(n, start = "2026-09-01") {
  const out = [], [y, m, d] = start.split("-").map(Number), t0 = Date.UTC(y, m - 1, d);
  for (let i = 0; i < n; i++) {
    const date = new Date(t0 + i * 86400000).toISOString().slice(0, 10);
    out.push({ date, rhr: 50 + (i % 5), rmssd: 60 + (i % 3), sleep: 7 + (i % 2) * 0.5, weight: i % 7 === 0 ? 80.2 : null, sys: i % 3 === 0 ? 120 + i % 4 : null, dia: i % 3 === 0 ? 78 : null });
  }
  return out;
}
const daily = days(28);
const rep = R.buildReport(daily, { generated: "2026-10-21T12:00:00Z", patient: { name: "Test Person", birthDate: "1980-05-06" } });

test("metric summaries", () => {
  const rhr = rep.metrics.find((m) => m.key === "rhr");
  assert.equal(rhr.n, 28); assert.equal(rhr.min, 50); assert.equal(rhr.max, 54);
  assert.equal(rhr.latest.date, "2026-09-28");
  assert.equal(rhr.unit, "bpm");
  assert.ok(rhr.weekly.length >= 4);
  assert.equal(rhr.weekly[0].weekStart, "2026-08-31", "weeks start on Monday");
  const w = rep.metrics.find((m) => m.key === "weight");
  assert.equal(w.n, 4);
  assert.equal(rep.bloodPressure.n, 10);
  same(rep.period, { from: "2026-09-01", to: "2026-09-28", daysWithData: 28 });
});

test("day numbers are accepted like the app's core uses", () => {
  const z = Date.UTC(2026, 8, 1) / 86400000;
  const r2 = R.buildReport([{ date: z, rhr: 55 }, { date: z + 1, rhr: 57 }]);
  same(r2.period, { from: "2026-09-01", to: "2026-09-02", daysWithData: 2 });
});

test("period filter, include switches, implausible values skipped", () => {
  const r2 = R.buildReport([...daily, { date: "2026-09-10", rhr: 900 }, { date: "bad", rhr: 50 }, { date: "2026-02-30", rhr: 50 }], { from: "2026-09-08", to: "2026-09-14", include: { sleep: false, bp: false } });
  assert.equal(r2.metrics.find((m) => m.key === "rhr").n, 7);
  assert.equal(r2.metrics.find((m) => m.key === "sleep"), undefined);
  assert.equal(r2.bloodPressure, null);
  assert.ok(r2.skippedValues >= 3);
});

test("FHIR bundle structure and LOINC codes", () => {
  const b = R.toFhirBundle(rep);
  assert.equal(b.resourceType, "Bundle"); assert.equal(b.type, "collection");
  assert.equal(b.timestamp, "2026-10-21T12:00:00Z");
  const res = b.entry.map((e) => e.resource);
  assert.equal(res[0].resourceType, "Patient"); assert.equal(res[0].name[0].text, "Test Person");
  for (const e of b.entry) assert.match(e.fullUrl, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(b.entry.map((e) => e.fullUrl)).size, b.entry.length, "fullUrls are unique");
  const obs = res.filter((r) => r.resourceType === "Observation");
  const codes = (c) => obs.filter((o) => o.code.coding && o.code.coding[0].code === c);
  assert.equal(codes("40443-4").length, 28);
  assert.equal(codes("40443-4")[0].valueQuantity.code, "/min");
  assert.equal(codes("40443-4")[0].valueQuantity.system, "http://unitsofmeasure.org");
  assert.equal(codes("93832-4").length, 28);
  assert.equal(codes("93832-4")[0].valueQuantity.code, "h");
  assert.equal(codes("29463-7").length, 4);
  const bp = codes("85354-9");
  assert.equal(bp.length, 10);
  same(bp[0].component.map((c) => [c.code.coding[0].code, c.valueQuantity.code]), [["8480-6", "mm[Hg]"], ["8462-4", "mm[Hg]"]]);
  assert.equal(bp[0].category[0].coding[0].code, "vital-signs");
  const hrv = obs.filter((o) => !o.code.coding);
  assert.equal(hrv.length, 28); assert.match(hrv[0].code.text, /RMSSD/);
  for (const o of obs) { assert.equal(o.status, "final"); assert.equal(o.subject.reference, b.entry[0].fullUrl); assert.match(o.effectiveDateTime, /^\d{4}-\d{2}-\d{2}$/); }
});

test("bundle is deterministic and parses back with PulseFHIR", () => {
  const a = JSON.stringify(R.toFhirBundle(rep)), b = JSON.stringify(R.toFhirBundle(R.buildReport(daily, { generated: "2026-10-21T12:00:00Z", patient: { name: "Test Person", birthDate: "1980-05-06" } })));
  assert.equal(a, b);
  const back = F.parse(a);
  assert.equal(back.patient.name, "Test Person");
  assert.equal(back.observations.filter((o) => o.loinc === "40443-4").length, 28);
});

test("labs and medications the user chose are carried, with the lab's own range", () => {
  const labs = [{ name: "Glucose", loinc: "2345-7", value: 105, unit: "mg/dL", date: "2024-03-01", referenceRange: [{ low: 70, high: 99 }] }, { name: "Color", valueText: "Yellow", referenceRange: [] }, null, "x"];
  const meds = [{ text: "Example medicine 10 mg", dosage: "once daily", status: "active" }, { text: "" }];
  const r2 = R.buildReport(daily, { labs, medications: meds });
  assert.equal(r2.labs.length, 2); assert.equal(r2.medications.length, 1);
  const b = R.toFhirBundle(r2);
  const lab = b.entry.map((e) => e.resource).find((r) => r.code && r.code.text === "Glucose");
  same(lab.referenceRange, [{ low: { value: 70, unit: "mg/dL" }, high: { value: 99, unit: "mg/dL" } }]);
  assert.equal(lab.category[0].coding[0].code, "laboratory");
  const ms = b.entry.map((e) => e.resource).find((r) => r.resourceType === "MedicationStatement");
  assert.equal(ms.status, "active"); assert.equal(ms.dosage[0].text, "once daily");
  const txt = R.summaryText(r2);
  assert.ok(txt.includes("Glucose: 105 mg/dL (lab range 70 to 99), 2024-03-01"));
});

test("plain-text summary has no diagnosis or interpretation wording", () => {
  const txt = R.summaryText(rep);
  assert.ok(txt.includes("Resting heart rate (bpm): mean"));
  assert.ok(txt.includes("Blood pressure (mmHg): mean"));
  const banned = /diagnos|disease|disorder|abnormal|\bnormal\b|healthy|risk|hypertens|elevated|concerning|warning|should|recommend|treat/i;
  assert.ok(!banned.test(txt), "found: " + (txt.match(banned) || [])[0]);
  noEmDash(txt, "summary");
  assert.ok(!banned.test(JSON.stringify(rep.notes)));
});

test("empty and hostile input", () => {
  const r0 = R.buildReport([]);
  assert.equal(R.summaryText(r0).includes("No measurements"), true);
  assert.equal(R.toFhirBundle(r0).entry.length, 1);
  throwsCode(() => R.buildReport("x"), "input");
  throwsCode(() => R.toFhirBundle({}), "input");
  const evil = JSON.parse('[{"date":"2026-09-01","rhr":50,"__proto__":{"polluted":1}}]');
  const r1 = R.buildReport(evil, { patient: JSON.parse('{"__proto__":{"name":"x"}}'), generated: "<script>" });
  assert.equal(r1.patient.name, null); assert.equal(r1.generated, null);
  assert.equal({}.polluted, undefined);
  const r3 = R.buildReport([{ date: "2026-09-01", rhr: 50 }], { patient: { name: "A‮b\u0000c" } });
  assert.equal(r3.patient.name, "A b c");
});
