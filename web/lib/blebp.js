// PulseBLEBP: Bluetooth Blood Pressure Measurement (characteristic 0x2A35)
// decoder with IEEE-11073 16-bit SFLOAT. Pure functions: no DOM, no network,
// no storage. Layout per the Bluetooth SIG GATT Specification Supplement,
// "Blood Pressure Measurement" and "Date Time" (see web/lib/README.md).
var PulseBLEBP = (function () {
  "use strict";

  var MAX_BYTES = 512;
  var KPA_TO_MMHG = 7.500615758456564; // 1 kPa = 1000 Pa; 1 mmHg = 133.322387415 Pa

  function err(code, message) { var e = new Error(message); e.code = code; return e; }

  function toBytes(input) {
    if (input === null || input === undefined) throw err("input", "No data.");
    var tag = Object.prototype.toString.call(input);
    var out = [], i;
    if (tag === "[object DataView]") {
      if (input.byteLength > MAX_BYTES) throw err("size", "Packet is longer than " + MAX_BYTES + " bytes.");
      for (i = 0; i < input.byteLength; i++) out.push(input.getUint8(i));
      return out;
    }
    if (tag === "[object ArrayBuffer]") input = new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      var v = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      if (v.length > MAX_BYTES) throw err("size", "Packet is longer than " + MAX_BYTES + " bytes.");
      for (i = 0; i < v.length; i++) out.push(v[i]);
      return out;
    }
    if (Array.isArray(input)) {
      if (input.length > MAX_BYTES) throw err("size", "Packet is longer than " + MAX_BYTES + " bytes.");
      for (i = 0; i < input.length; i++) {
        var b = input[i];
        if (typeof b !== "number" || !(b >= 0 && b <= 255) || Math.floor(b) !== b) throw err("byte", "Byte " + i + " is not a value from 0 to 255.");
        out.push(b);
      }
      return out;
    }
    throw err("input", "Expected bytes (DataView, ArrayBuffer, typed array or array).");
  }

  // IEEE-11073 SFLOAT: high 4 bits = signed exponent (base 10), low 12 bits =
  // signed mantissa. Reserved special values (exponent 0):
  // 0x07FF NaN, 0x0800 NRes (not at this resolution), 0x07FE +INF,
  // 0x0802 -INF, 0x0801 reserved.
  var SPECIAL = { 0x07FF: "nan", 0x0800: "nres", 0x07FE: "+inf", 0x0802: "-inf", 0x0801: "reserved" };

  function decodeSfloat(raw) {
    if (typeof raw !== "number" || !(raw >= 0 && raw <= 0xFFFF) || Math.floor(raw) !== raw) throw err("sfloat", "SFLOAT must be a 16-bit unsigned value.");
    if (Object.prototype.hasOwnProperty.call(SPECIAL, raw)) {
      var sp = SPECIAL[raw];
      return { value: sp === "+inf" ? Infinity : (sp === "-inf" ? -Infinity : null), special: sp, raw: raw };
    }
    var m = raw & 0x0FFF, e = (raw >> 12) & 0x0F;
    if (m >= 0x0800) m -= 0x1000;
    if (e >= 0x08) e -= 0x10;
    // Divide for negative exponents so 1205e-1 is exactly 120.5.
    var v = e < 0 ? m / Math.pow(10, -e) : m * Math.pow(10, e);
    return { value: v, special: null, raw: raw };
  }

  // Encodes a finite value at a given exponent (-8..7). Used by tests and by
  // any simulator; throws when the mantissa does not fit in 12 bits.
  function encodeSfloat(value, exponent) {
    if (value === "nan") return 0x07FF;
    if (value === "nres") return 0x0800;
    if (value === Infinity) return 0x07FE;
    if (value === -Infinity) return 0x0802;
    var e = exponent || 0;
    if (!(e >= -8 && e <= 7) || Math.floor(e) !== e) throw err("sfloat", "Exponent must be an integer from -8 to 7.");
    if (typeof value !== "number" || !isFinite(value)) throw err("sfloat", "Value must be finite.");
    var m = Math.round(e < 0 ? value * Math.pow(10, -e) : value / Math.pow(10, e));
    if (m < -2046 || m > 2045) throw err("sfloat", "Mantissa " + m + " does not fit in 12 bits.");
    if (e === 0 && (m === 0x07FF || m === 0x07FE || m === -2048 || m === -2047 || m === -2046)) throw err("sfloat", "Value collides with a reserved code.");
    return ((e & 0x0F) << 12) | (m & 0x0FFF);
  }

  function u16(b, p) { return b[p] | (b[p + 1] << 8); }
  function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }

  // Date Time characteristic: year u16 (0 = unknown), month u8 (0 = unknown),
  // day u8 (0 = unknown), hours, minutes, seconds (u8 each). No time zone.
  function decodeDateTime(b, p) {
    var y = u16(b, p), mo = b[p + 2], d = b[p + 3], h = b[p + 4], mi = b[p + 5], s = b[p + 6];
    var valid = (y === 0 || (y >= 1582 && y <= 9999)) && mo <= 12 && d <= 31 && h <= 23 && mi <= 59 && s <= 59;
    var known = y !== 0 && mo !== 0 && d !== 0;
    var dim = known ? new Date(Date.UTC(y, mo, 0)).getUTCDate() : 31;
    if (known && d > dim) valid = false;
    return {
      year: y, month: mo, day: d, hours: h, minutes: mi, seconds: s,
      valid: valid,
      // Local wall-clock time of the cuff, without a zone. Null if any part is unknown or invalid.
      local: valid && known ? pad(y, 4) + "-" + pad(mo, 2) + "-" + pad(d, 2) + "T" + pad(h, 2) + ":" + pad(mi, 2) + ":" + pad(s, 2) : null
    };
  }

  var RANGE = ["in-range", "above-upper-limit", "below-lower-limit", "reserved"];

  // Layout: flags u8 | systolic SFLOAT | diastolic SFLOAT | MAP SFLOAT |
  // [Date Time 7 bytes] | [pulse rate SFLOAT] | [user id u8] | [status u16]
  // Flags: bit0 unit kPa (else mmHg), bit1 time stamp, bit2 pulse rate,
  // bit3 user id, bit4 measurement status, bits5-7 reserved.
  function decodeBloodPressure(input) {
    var b = toBytes(input), warnings = [];
    if (b.length < 7) throw err("short", "Blood pressure packet is shorter than 7 bytes.");
    var flags = b[0], p = 1;
    if (flags & 0xE0) warnings.push("Reserved flag bits are set; they were ignored.");
    var kpa = (flags & 0x01) !== 0;
    var sys = decodeSfloat(u16(b, 1)), dia = decodeSfloat(u16(b, 3)), map = decodeSfloat(u16(b, 5));
    p = 7;
    var ts = null, pulse = null, user = null, status = null;
    if (flags & 0x02) {
      if (b.length < p + 7) throw err("short", "Flags say a time stamp is present but the packet ends early.");
      ts = decodeDateTime(b, p); p += 7;
      if (!ts.valid) warnings.push("Time stamp has out-of-range fields.");
    }
    if (flags & 0x04) {
      if (b.length < p + 2) throw err("short", "Flags say pulse rate is present but the packet ends early.");
      pulse = decodeSfloat(u16(b, p)); p += 2;
    }
    if (flags & 0x08) {
      if (b.length < p + 1) throw err("short", "Flags say a user id is present but the packet ends early.");
      user = b[p]; p += 1;
    }
    if (flags & 0x10) {
      if (b.length < p + 2) throw err("short", "Flags say measurement status is present but the packet ends early.");
      var st = u16(b, p); p += 2;
      status = {
        raw: st,
        bodyMovement: (st & 0x01) !== 0,
        cuffTooLoose: (st & 0x02) !== 0,
        irregularPulse: (st & 0x04) !== 0,
        pulseRateRange: RANGE[(st >> 3) & 0x03],
        improperPosition: (st & 0x20) !== 0
      };
      if (st & 0xFFC0) warnings.push("Reserved measurement status bits are set.");
    }
    if (p < b.length) warnings.push((b.length - p) + " trailing byte(s) ignored.");
    function mm(x) { return x.value === null || !isFinite(x.value) ? null : (kpa ? x.value * KPA_TO_MMHG : x.value); }
    return {
      flags: flags,
      unit: kpa ? "kPa" : "mmHg",
      systolic: sys.value, diastolic: dia.value, meanArterial: map.value,
      special: { systolic: sys.special, diastolic: dia.special, meanArterial: map.special, pulseRate: pulse ? pulse.special : null },
      systolicMmHg: mm(sys), diastolicMmHg: mm(dia), meanArterialMmHg: mm(map),
      timestamp: ts,
      pulseRate: pulse ? pulse.value : null,
      userId: user,
      userKnown: user === null ? null : user !== 255,
      status: status,
      warnings: warnings
    };
  }

  return Object.freeze({
    SERVICE_UUID: 0x1810,
    CHARACTERISTIC_UUID: 0x2A35,
    KPA_TO_MMHG: KPA_TO_MMHG,
    toBytes: toBytes,
    decodeSfloat: decodeSfloat,
    encodeSfloat: encodeSfloat,
    decodeDateTime: function (bytes) { var b = toBytes(bytes); if (b.length < 7) throw err("short", "Date Time needs 7 bytes."); return decodeDateTime(b, 0); },
    decodeBloodPressure: decodeBloodPressure
  });
})();
