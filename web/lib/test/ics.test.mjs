import { test, load, throwsCode, assert } from "./harness.mjs";
const I = load("ics.js", "PulseICS");
const NOW = Date.UTC(2026, 9, 21, 18, 4, 5);

test("TEXT escaping per RFC 5545 3.3.11", () => {
  assert.equal(I.escapeText("a,b;c\\d\ne:f"), "a\\,b\\;c\\\\d\\ne:f");
  assert.equal(I.escapeText("x\r\ny\rz"), "x\\ny\\nz");
  assert.equal(I.escapeText("bell\u0007"), "bell");
});

test("folding at 75 octets, CRLF + space, never inside a UTF-8 sequence", () => {
  const line = "DESCRIPTION:" + "é".repeat(100) + "😴".repeat(20) + "x".repeat(80);
  const folded = I.fold(line);
  const phys = folded.split("\r\n");
  for (let i = 0; i < phys.length; i++) {
    const bytes = Buffer.from(phys[i], "utf8");
    assert.ok(bytes.length <= 75, "line " + i + " is " + bytes.length + " octets");
    if (i) assert.equal(phys[i][0], " ");
    assert.ok(!phys[i].includes("�"));
    assert.ok(!/[\ud800-\udbff]$/.test(phys[i]), "split surrogate pair");
  }
  assert.equal(I.unfold(folded)[0], line);
  assert.equal(I.fold("short"), "short");
});

test("bedtime and wake window across midnight", () => {
  const ics = I.sleepEvents({ date: "2026-10-21", bedtime: "22:30", wakeStart: "06:15", wakeEnd: "06:45", now: NOW });
  assert.ok(ics.endsWith("\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "every newline is CRLF");
  const L = I.unfold(ics);
  assert.equal(L[0], "BEGIN:VCALENDAR"); assert.equal(L[L.length - 1], "END:VCALENDAR");
  assert.ok(L.includes("VERSION:2.0"));
  assert.ok(L.some((l) => l.startsWith("PRODID:")));
  assert.equal(L.filter((l) => l === "BEGIN:VEVENT").length, 2);
  assert.equal(L.filter((l) => l === "DTSTAMP:20261021T180405Z").length, 2);
  assert.ok(L.includes("DTSTART:20261021T223000"));
  assert.ok(L.includes("DTEND:20261021T224500"));
  assert.ok(L.includes("DTSTART:20261022T061500"));
  assert.ok(L.includes("DTEND:20261022T064500"));
  assert.ok(L.includes("SUMMARY:Wake window"));
  assert.equal(L.filter((l) => l.startsWith("UID:")).length, 2);
  assert.equal(new Set(L.filter((l) => l.startsWith("UID:"))).size, 2);
  // Each VALARM has ACTION, DESCRIPTION and TRIGGER (required for DISPLAY).
  const alarms = ics.split("BEGIN:VALARM").slice(1).map((a) => a.split("END:VALARM")[0]);
  assert.equal(alarms.length, 2);
  for (const a of alarms) { assert.match(a, /ACTION:DISPLAY/); assert.match(a, /DESCRIPTION:/); assert.match(a, /TRIGGER:-PT\d+M/); }
  // The limit is stated in the event itself.
  assert.ok(L.some((l) => l.includes("cannot wake you")));
  // No DURATION alongside DTEND.
  assert.ok(!L.some((l) => l.startsWith("DURATION")));
});

test("bedtime after midnight and month/year rollover", () => {
  const L = I.unfold(I.sleepEvents({ date: "2026-12-31", bedtime: "00:30", wakeStart: "08:00", wakeEnd: "08:30", now: NOW }));
  assert.ok(L.includes("DTSTART:20270101T003000"));
  assert.ok(L.includes("DTSTART:20270101T080000"));
});

test("repeat daily, notes escaping, options", () => {
  const ics = I.sleepEvents({ date: "2026-10-21", bedtime: "23:00", wakeStart: "07:00", wakeEnd: "07:20", now: NOW, repeatDaily: true, count: 14, notes: "Line one, with; chars\nLine two", wakeAlarm: false, bedtimeAlarmMinutes: null, uidDomain: "example.org" });
  const L = I.unfold(ics);
  assert.equal(L.filter((l) => l === "RRULE:FREQ=DAILY;COUNT=14").length, 2);
  assert.ok(L.some((l) => l.includes("Line one\\, with\\; chars\\nLine two")));
  assert.ok(!ics.includes("BEGIN:VALARM"));
  assert.ok(L.every((l) => !l.startsWith("UID:") || l.endsWith("@example.org")));
});

test("bad input", () => {
  const base = { date: "2026-10-21", bedtime: "22:30", wakeStart: "06:15", wakeEnd: "06:45", now: NOW };
  throwsCode(() => I.sleepEvents({ ...base, date: "2026-02-30" }), "date");
  throwsCode(() => I.sleepEvents({ ...base, date: "21/10/2026" }), "date");
  throwsCode(() => I.sleepEvents({ ...base, bedtime: "25:00" }), "time");
  throwsCode(() => I.sleepEvents({ ...base, wakeEnd: "10:45" }), "time");
  throwsCode(() => I.sleepEvents({ ...base, now: undefined }), "time");
  throwsCode(() => I.sleepEvents({ ...base, bedtimeAlarmMinutes: -1 }), "input");
  throwsCode(() => I.sleepEvents(null), "input");
  const L = I.unfold(I.sleepEvents({ ...base, uidDomain: "evil\r\nX-INJECT:1", notes: "\r\nBEGIN:VEVENT" }));
  assert.ok(!L.some((l) => l.startsWith("X-INJECT")));
  assert.equal(L.filter((l) => l === "BEGIN:VEVENT").length, 2);
});
