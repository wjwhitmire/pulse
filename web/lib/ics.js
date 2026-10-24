// PulseICS: iCalendar (RFC 5545) events for bedtime and a wake window.
// CRLF line endings, lines folded at 75 octets without splitting UTF-8
// sequences, TEXT escaping per section 3.3.11. Pure: the caller supplies
// the current time (for DTSTAMP) and, if it wants, a UID.
var PulseICS = (function () {
  "use strict";

  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function own(o, k) { return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k); }
  function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }

  // ------------------------------------------------------------ text
  // TEXT escaping: backslash, semicolon, comma, newline. Colons are not escaped.
  function escapeText(s) {
    return String(s)
      .replace(/\r\n|\r/g, "\n")
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
      .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  }
  function utf8Len(cp) { return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; }
  // Fold one content line: no physical line longer than 75 octets (excluding
  // CRLF); continuation lines start with one space, which counts toward 75.
  function fold(line) {
    var out = [], cur = "", octets = 0, limit = 75;
    for (var i = 0; i < line.length; i++) {
      var cp = line.codePointAt(i), ch = String.fromCodePoint(cp);
      if (cp > 0xFFFF) i++;
      var n = utf8Len(cp);
      if (octets + n > limit) { out.push(cur); cur = " "; octets = 1; }
      cur += ch; octets += n;
    }
    out.push(cur);
    return out.join("\r\n");
  }

  // ------------------------------------------------------------ time
  function fdiv(a, b) { return Math.floor(a / b); }
  function daysFromCivil(y, m, d) {
    y -= m <= 2 ? 1 : 0;
    var era = fdiv(y >= 0 ? y : y - 399, 400), yoe = y - era * 400;
    var doy = fdiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;
    return era * 146097 + yoe * 365 + fdiv(yoe, 4) - fdiv(yoe, 100) + doy - 719468;
  }
  function civilFromDays(z) {
    z += 719468;
    var era = fdiv(z >= 0 ? z : z - 146096, 146097), doe = z - era * 146097;
    var yoe = fdiv(doe - fdiv(doe, 1460) + fdiv(doe, 36524) - fdiv(doe, 146096), 365);
    var doy = doe - (365 * yoe + fdiv(yoe, 4) - fdiv(yoe, 100)), mp = fdiv(5 * doy + 2, 153);
    var d = doy - fdiv(153 * mp + 2, 5) + 1, m = mp + (mp < 10 ? 3 : -9);
    return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
  }
  function parseDate(s) {
    var m = typeof s === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim()) : null;
    if (!m) throw err("date", "Date must be YYYY-MM-DD.");
    var z = daysFromCivil(+m[1], +m[2], +m[3]), c = civilFromDays(z);
    if (c[0] !== +m[1] || c[1] !== +m[2] || c[2] !== +m[3]) throw err("date", "Date does not exist.");
    return z;
  }
  function parseClock(s) {
    var m = typeof s === "string" ? /^(\d{1,2}):(\d{2})$/.exec(s.trim()) : null;
    if (!m || +m[1] > 23 || +m[2] > 59) throw err("time", "Time must be HH:MM (24 hour).");
    return +m[1] * 60 + +m[2];
  }
  // Minutes since 1970-01-01 00:00 in floating local time -> "YYYYMMDDTHHMMSS".
  function floating(min) {
    var z = fdiv(min, 1440), r = min - z * 1440, c = civilFromDays(z);
    return pad(c[0], 4) + pad(c[1], 2) + pad(c[2], 2) + "T" + pad(fdiv(r, 60), 2) + pad(r % 60, 2) + "00";
  }
  function utcStamp(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0 || ms > 253402300799000) throw err("time", "now must be milliseconds since 1970.");
    var s = fdiv(ms, 1000), z = fdiv(s, 86400), r = s - z * 86400, c = civilFromDays(z);
    return pad(c[0], 4) + pad(c[1], 2) + pad(c[2], 2) + "T" + pad(fdiv(r, 3600), 2) + pad(fdiv(r % 3600, 60), 2) + pad(r % 60, 2) + "Z";
  }
  function hash(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return pad(h.toString(16), 8);
  }

  // ------------------------------------------------------------ build
  function vevent(e, stamp) {
    var L = ["BEGIN:VEVENT", "UID:" + e.uid, "DTSTAMP:" + stamp, "DTSTART:" + e.start, "DTEND:" + e.end, "SUMMARY:" + escapeText(e.summary)];
    if (e.description) L.push("DESCRIPTION:" + escapeText(e.description));
    if (e.rrule) L.push("RRULE:" + e.rrule);
    L.push("TRANSP:TRANSPARENT");
    if (e.alarmMinutes !== null && e.alarmMinutes !== undefined) {
      L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + escapeText(e.summary), "TRIGGER:-PT" + e.alarmMinutes + "M", "END:VALARM");
    }
    L.push("END:VEVENT");
    return L;
  }

  function calendar(events, now) {
    var stamp = utcStamp(now);
    var L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pulse//Sleep schedule//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
    for (var i = 0; i < events.length; i++) L = L.concat(vevent(events[i], stamp));
    L.push("END:VCALENDAR");
    return L.map(fold).join("\r\n") + "\r\n";
  }

  // Bedtime reminder plus wake window. opts:
  //   date: "YYYY-MM-DD", the evening the night starts
  //   bedtime: "HH:MM"; times before 12:00 are taken as after midnight
  //   wakeStart, wakeEnd: "HH:MM", the first occurrence after bedtime
  //   now: ms since 1970 (DTSTAMP), required
  //   repeatDaily: true adds RRULE:FREQ=DAILY (optional count)
  //   bedtimeAlarmMinutes (default 30), wakeAlarm (default true)
  //   uidDomain (default "pulse.invalid"), notes (extra description text)
  // Times are floating local times, so the calendar shows them in whatever
  // time zone the device is in.
  function sleepEvents(opts) {
    if (!opts || typeof opts !== "object") throw err("input", "Options are required.");
    var day = parseDate(opts.date);
    var bed = parseClock(opts.bedtime), ws = parseClock(opts.wakeStart), we = parseClock(opts.wakeEnd);
    var bedAbs = day * 1440 + bed + (bed < 720 ? 1440 : 0);
    var wsAbs = day * 1440 + ws; while (wsAbs <= bedAbs) wsAbs += 1440;
    var weAbs = day * 1440 + we; while (weAbs <= wsAbs) weAbs += 1440;
    if (weAbs - wsAbs > 180) throw err("time", "The wake window is longer than 3 hours.");
    if (wsAbs - bedAbs > 16 * 60) throw err("time", "Wake time is more than 16 hours after bedtime.");
    var bedEnd = Math.min(bedAbs + 15, wsAbs);
    var rrule = null;
    if (opts.repeatDaily) {
      var count = own(opts, "count") && opts.count >= 1 && opts.count <= 366 ? Math.floor(opts.count) : null;
      rrule = "FREQ=DAILY" + (count ? ";COUNT=" + count : "");
    }
    var domain = own(opts, "uidDomain") && /^[a-z0-9.-]{1,100}$/i.test(String(opts.uidDomain)) ? opts.uidDomain : "pulse.invalid";
    var key = floating(bedAbs) + "|" + floating(wsAbs) + "|" + floating(weAbs) + "|" + (rrule || "");
    var notes = own(opts, "notes") && typeof opts.notes === "string" ? opts.notes.slice(0, 500) : "";
    var bedAlarm = own(opts, "bedtimeAlarmMinutes") ? opts.bedtimeAlarmMinutes : 30;
    if (bedAlarm !== null && !(typeof bedAlarm === "number" && bedAlarm >= 0 && bedAlarm <= 720)) throw err("input", "Bedtime alarm must be 0 to 720 minutes.");
    var events = [
      { uid: "bed-" + hash(key) + "@" + domain, start: floating(bedAbs), end: floating(bedEnd), summary: "Bedtime",
        description: "Planned bedtime from Pulse." + (notes ? "\n" + notes : ""), rrule: rrule, alarmMinutes: bedAlarm === null ? null : Math.floor(bedAlarm) },
      { uid: "wake-" + hash(key) + "@" + domain, start: floating(wsAbs), end: floating(weAbs), summary: "Wake window",
        description: "Wake window from Pulse. Set your own alarm: a calendar event cannot wake you by itself." + (notes ? "\n" + notes : ""),
        rrule: rrule, alarmMinutes: opts.wakeAlarm === false ? null : 0 }
    ];
    return calendar(events, opts.now);
  }

  // Unfold and split lines (for tests and for reading back a file).
  function unfold(text) { return String(text).replace(/\r\n[ \t]/g, "").split("\r\n").filter(function (l) { return l.length; }); }

  return Object.freeze({
    escapeText: escapeText,
    fold: fold,
    unfold: unfold,
    sleepEvents: sleepEvents
  });
})();
