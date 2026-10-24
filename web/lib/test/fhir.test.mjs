import zlib from "node:zlib";
import { test, load, fixture, throwsCode, assert, same } from "./harness.mjs";
const F = load("fhir.js", "PulseFHIR");
const BUNDLE = fixture("fhir_bundle.json");
const r = F.parse(BUNDLE);

test("bundle: counts per type, skips and unknown types", () => {
  same(r.counts, { conditions: 1, medications: 3, immunizations: 1, allergies: 1, observations: 5 });
  assert.equal(r.skipped["Condition (entered-in-error)"], 1);
  assert.equal(r.skipped["Observation (entered-in-error)"], 1);
  assert.equal(r.skipped["Encounter"], 1);
});

test("patient is minimal", () => {
  same(r.patient, { id: "p1", name: "Test Person", birthDate: "1980-01-01", gender: "other" });
});

test("condition fields", () => {
  const c = r.conditions[0];
  assert.equal(c.text, "Hypertensive disorder");
  assert.equal(c.clinicalStatus, "active"); assert.equal(c.verificationStatus, "confirmed");
  assert.equal(c.onset, "2019-04-02"); assert.equal(c.recorded, "2019-04-03"); assert.equal(c.date, "2019-04-02");
  assert.equal(c.codes[0].system, "http://snomed.info/sct");
});

test("medications resolve references, contained resources and codings", () => {
  const byId = Object.fromEntries(r.medications.map((m) => [m.id, m]));
  assert.equal(byId.mr1.text, "Lisinopril 10 MG Oral Tablet"); assert.equal(byId.mr1.kind, "request");
  assert.equal(byId.mr1.dosage, "1 tablet daily"); assert.equal(byId.mr1.date, "2019-04-03");
  assert.equal(byId.mr2.text, "Contained med");
  assert.equal(byId.ms1.text, "Amlodipine 5 MG Oral Tablet"); assert.equal(byId.ms1.date, "2020-01-01"); assert.equal(byId.ms1.kind, "statement");
});

test("immunization and allergy", () => {
  const i = r.immunizations[0];
  assert.equal(i.text, "COVID-19 vaccine"); assert.equal(i.date, "2021-04-01"); assert.equal(i.lotNumber, "AB123"); assert.equal(i.performer, "Clinic A");
  const a = r.allergies[0];
  assert.equal(a.text, "Penicillin"); assert.equal(a.criticality, "high");
  same(a.reactions, [{ manifestations: ["Hives"], severity: "moderate" }]);
  same(a.category, ["medication"]);
});

test("lab observations: value, unit, range, position against the lab's own range", () => {
  const g = r.observations.find((o) => o.id === "o1");
  assert.equal(g.kind, "lab"); assert.equal(g.loinc, "2345-7");
  assert.equal(g.value, 105); assert.equal(g.unit, "mg/dL");
  same(g.referenceRange, [{ low: 70, high: 99, unit: "mg/dL", text: null, appliesTo: [] }]);
  assert.equal(g.position, "above");
  assert.equal(r.observations.find((o) => o.id === "o2").position, "within");
  const chol = r.observations.find((o) => o.id === "o3");
  assert.equal(chol.position, null, "text-only range is shown, not evaluated");
  assert.equal(chol.referenceRange[0].text, "<200 mg/dL");
  assert.equal(r.observations.find((o) => o.id === "o6").valueText, "Yellow");
});

test("vital BP panel components", () => {
  const bp = r.observations.find((o) => o.id === "o4");
  assert.equal(bp.kind, "vital"); assert.equal(bp.value, null);
  same(bp.components.map((c) => [c.loinc, c.value, c.unit]), [["8480-6", 128, "mm[Hg]"], ["8462-4", 82, "mm[Hg]"]]);
});

test("lab series groups by LOINC, sorted by date", () => {
  const s = F.labSeries(r.observations);
  const glu = s.find((x) => x.loinc === "2345-7");
  same(glu.points.map((p) => [p.date, p.value]), [["2023-03-01", 88], ["2024-03-01T08:00:00Z", 105]]);
});

test("timeline is date ordered with undated last", () => {
  const t = F.timeline(r);
  const dated = t.filter((e) => e.date);
  for (let i = 1; i < dated.length; i++) assert.ok(dated[i - 1].date <= dated[i].date);
  assert.equal(t[t.length - 1].date, null);
  assert.equal(t[0].type, "allergy");
});

test("Apple Health clinical record: single resource file, DSTU2 names", () => {
  const one = F.parse(JSON.stringify({ resourceType: "Immunization", id: "z", status: "completed", vaccineCode: { text: "Influenza" }, date: "2018-10-01" }));
  assert.equal(one.immunizations[0].date, "2018-10-01");
  const al = F.parse({ resourceType: "AllergyIntolerance", substance: { text: "Peanut" }, status: "active", recordedDate: "2010-01-01" });
  assert.equal(al.allergies[0].text, "Peanut"); assert.equal(al.allergies[0].clinicalStatus, "active");
  const many = F.parseMany([BUNDLE, "{bad", JSON.stringify({ resourceType: "Condition", code: { text: "X" }, dateRecorded: "2001-02-03" })]);
  assert.equal(many.conditions.length, 2);
  assert.equal(many.warnings.length, 1);
  assert.equal(many.conditions.find((c) => c.text === "X").date, "2001-02-03");
});

test("rejects things that are not plain JSON", () => {
  throwsCode(() => F.parse("<Bundle xmlns='http://hl7.org/fhir'/>"), "format");
  throwsCode(() => F.parse("not json"), "format");
  throwsCode(() => F.parse("{\"a\": }"), "json");
  throwsCode(() => F.parse(42), "format");
  throwsCode(() => F.parse({ resourceType: "Patient", birthDate: new Date() }), "json");
  throwsCode(() => F.parse({ resourceType: "Patient", f: () => 1 }), "json");
  class Evil { constructor() { this.resourceType = "Patient"; } }
  throwsCode(() => F.parse(new Evil()), "json");
  const getter = { resourceType: "Patient" };
  Object.defineProperty(getter, "id", { get() { throw new Error("side effect"); }, enumerable: true });
  throwsCode(() => F.parse(getter), "json");
  throwsCode(() => F.parse({ resourceType: "Patient", [Symbol("s")]: 1 }), "json");
  throwsCode(() => F.parse({ a: NaN }), "json");
  let deep = {}; const root = deep; for (let i = 0; i < 100; i++) { deep.a = {}; deep = deep.a; }
  throwsCode(() => F.parse(root), "depth");
  throwsCode(() => F.parse("[" + "[".repeat(200) + "]".repeat(200) + "]"), "depth");
});

test("prototype pollution keys are dropped", () => {
  const evil = '{"resourceType":"Bundle","__proto__":{"polluted":1},"entry":[{"resource":{"resourceType":"Patient","constructor":{"prototype":{"polluted":2}},"name":[{"text":"A","__proto__":{"x":1}}]}}]}';
  const out = F.parse(evil);
  assert.equal(out.patient.name, "A");
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const clean = F.sanitize(JSON.parse(evil));
  assert.ok(!Object.prototype.hasOwnProperty.call(clean, "__proto__"));
});

test("hostile strings are cleaned and capped", () => {
  const out = F.parse({ resourceType: "Condition", code: { text: "A\u0000B‮​" + "x".repeat(5000) }, onsetDateTime: "2020-01-01<script>" });
  assert.ok(out.conditions[0].text.startsWith("ABx"));
  assert.equal(out.conditions[0].text.length, 2000);
  assert.equal(out.conditions[0].onset, null, "malformed date dropped");
  const types = F.parse({ resourceType: { x: 1 } });
  assert.equal(types.counts.conditions, 0);
});

test("huge arrays are bounded", () => {
  const entry = new Array(150000).fill({ resource: { resourceType: "Observation", status: "final", code: { text: "x" }, valueQuantity: { value: 1 } } });
  const out = F.parse({ resourceType: "Bundle", entry });
  assert.ok(out.observations.length <= 100000);
  throwsCode(() => F.parse("x".repeat(33 * 1024 * 1024)), "size");
});

// ------------------------------------------------------------ SMART Health Card
function b64u(buf) { return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function makeCard(payloadObj, header = { zip: "DEF", alg: "ES256", kid: "test-kid" }) {
  const raw = Buffer.from(JSON.stringify(payloadObj));
  const body = header.zip === "DEF" ? zlib.deflateRawSync(raw) : raw;
  return b64u(Buffer.from(JSON.stringify(header))) + "." + b64u(body) + "." + b64u(Buffer.from("not-a-real-signature"));
}
const shcPayload = {
  iss: "https://issuer.example.org", nbf: 1700000000,
  vc: { type: ["https://smarthealth.cards#health-card", "https://smarthealth.cards#immunization"],
    credentialSubject: { fhirVersion: "4.0.1", fhirBundle: { resourceType: "Bundle", type: "collection", entry: [
      { fullUrl: "resource:0", resource: { resourceType: "Patient", name: [{ family: "Card", given: ["Test"] }], birthDate: "1990-02-03" } },
      { fullUrl: "resource:1", resource: { resourceType: "Immunization", status: "completed", vaccineCode: { coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: "207" }] }, occurrenceDateTime: "2021-01-10" } }] } } }
};
const inflate = (b) => zlib.inflateRawSync(Buffer.from(b));

test("SMART Health Card JWS decodes and is marked unverified", () => {
  const card = F.decodeHealthCard(makeCard(shcPayload), inflate);
  assert.equal(card.signature, "unverified"); assert.equal(card.verified, false);
  assert.equal(card.issuer, "https://issuer.example.org");
  assert.equal(card.issued, "2023-11-14T22:13:20Z");
  assert.equal(card.isHealthCard, true); assert.equal(card.fhirVersion, "4.0.1");
  assert.equal(card.records.patient.name, "Test Card");
  assert.equal(card.records.immunizations[0].text, "207");
  assert.equal(card.header.zip, "DEF");
});

test("shc:/ numeric QR content decodes", () => {
  const jws = makeCard(shcPayload);
  const numeric = "shc:/" + Array.from(jws, (ch) => String(ch.charCodeAt(0) - 45).padStart(2, "0")).join("");
  assert.equal(F.shcNumericToJws(numeric), jws);
  assert.equal(F.decodeHealthCard(numeric, inflate).records.immunizations.length, 1);
  throwsCode(() => F.shcNumericToJws("shc:/123"), "shc");
  throwsCode(() => F.shcNumericToJws("shc:/99"), "shc");
  throwsCode(() => F.shcNumericToJws("shc:/1/2/5676"), "shc");
});

test(".smart-health-card file with several credentials", () => {
  const file = JSON.stringify({ verifiableCredential: [makeCard(shcPayload), makeCard(shcPayload, { alg: "ES256" })] });
  const out = F.decodeHealthCard(file, inflate);
  assert.equal(out.cards.length, 2); assert.equal(out.verified, false);
  assert.equal(out.cards[1].header.zip, null);
});

test("SMART Health Card hostile input", () => {
  throwsCode(() => F.decodeHealthCard(makeCard(shcPayload)), "inflate");
  throwsCode(() => F.decodeHealthCard("a.b"), "shc");
  throwsCode(() => F.decodeHealthCard("a$.b.c", inflate), "shc");
  throwsCode(() => F.decodeHealthCard(b64u(Buffer.from('{"zip":"DEF"}')) + "." + b64u(Buffer.from("garbage")) + ".x", inflate), "shc");
  throwsCode(() => F.decodeHealthCard(b64u(Buffer.from('{"zip":"GZIP"}')) + ".AAAA.x", inflate), "shc");
  throwsCode(() => F.decodeHealthCard(makeCard(shcPayload), () => "not bytes"), "shc");
  throwsCode(() => F.decodeHealthCard(makeCard(shcPayload), () => new Uint8Array(6 * 1024 * 1024)), "size");
  throwsCode(() => F.decodeHealthCard("{\"verifiableCredential\": []}", inflate), "shc");
  throwsCode(() => F.decodeHealthCard(null), "shc");
  // Polluting payload keys are inert.
  const card = F.decodeHealthCard(makeCard(JSON.parse('{"__proto__":{"polluted":1},"vc":{"credentialSubject":{"fhirBundle":{"resourceType":"Bundle","entry":[]}}}}')), inflate);
  assert.equal(card.isHealthCard, false);
  assert.equal({}.polluted, undefined);
});

test("utf8 decoder handles multibyte and invalid sequences", () => {
  assert.equal(F.utf8Decode([...Buffer.from("café 中 😀")]), "café 中 😀");
  assert.equal(F.utf8Decode([0xC0, 0x80, 0x41]), "��A");
  assert.equal(F.utf8Decode([0xED, 0xA0, 0x80]), "�");
  same(F.base64urlDecode("SGk"), [72, 105]);
});
