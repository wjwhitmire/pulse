// Every module must be a plain script that defines exactly one global and
// touches no DOM, network, storage, timers or dynamic code.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test, assert, libDir } from "./harness.mjs";

const MODULES = {
  "blehr.js": "PulseBLEHR", "blebp.js": "PulseBLEBP", "record.js": "PulseRecord", "segments.js": "PulseSegments",
  "privacy.js": "PulsePrivacy", "route.js": "PulseRoute", "fhir.js": "PulseFHIR", "ecg.js": "PulseECG",
  "report.js": "PulseReport", "coach.js": "PulseCoach", "ics.js": "PulseICS"
};
const FORBIDDEN = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator|document|window|localStorage|sessionStorage|indexedDB|eval|Function\s*\(|require|import\s*\(|setTimeout|setInterval|Date\.now|Math\.random|crypto|innerHTML|postMessage)\b/;

test("module list matches the files on disk", () => {
  const files = fs.readdirSync(libDir).filter((f) => f.endsWith(".js")).sort();
  assert.deepEqual(files, Object.keys(MODULES).sort());
});

for (const [file, name] of Object.entries(MODULES)) {
  test(file + " defines only " + name + " and uses no forbidden APIs", () => {
    const src = fs.readFileSync(path.join(libDir, file), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n").replace(/\/\/[^\n"']*$/gm, "")
      .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""'); // string literals are text, not calls
    const m = code.match(FORBIDDEN);
    assert.equal(m, null, file + " uses " + (m && m[0]));
    assert.ok(!/\u2014/.test(src), file + " contains an em dash");
    const ctx = vm.createContext({});
    vm.runInContext(src, ctx);
    const globals = Object.keys(ctx);
    assert.deepEqual(globals, [name]);
    assert.ok(Object.isFrozen(ctx[name]), name + " is frozen");
  });
}

test("all modules load together into one context (as inlined in a single page)", () => {
  const ctx = vm.createContext({});
  for (const f of Object.keys(MODULES)) vm.runInContext(fs.readFileSync(path.join(libDir, f), "utf8"), ctx);
  assert.deepEqual(Object.keys(ctx).sort(), Object.values(MODULES).sort());
});
