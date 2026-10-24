// Runs every web/lib/test/*.test.mjs. Usage: node web/lib/test/run.mjs [filter]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registered } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || "";
const files = fs.readdirSync(here).filter((f) => f.endsWith(".test.mjs") && f.includes(filter)).sort();
const counts = new Map();
for (const f of files) {
  const before = registered().length;
  await import(pathToFileURL(path.join(here, f)).href);
  counts.set(f, registered().length - before);
}

let pass = 0, fail = 0, idx = 0;
for (const f of files) {
  const n = counts.get(f);
  const group = registered().slice(idx, idx + n);
  idx += n;
  let fpass = 0;
  for (const t of group) {
    try { await t.fn(); pass++; fpass++; }
    catch (e) {
      fail++;
      console.log("FAIL " + f + " :: " + t.name);
      console.log("     " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n     "));
    }
  }
  console.log((fpass === n ? "ok   " : "FAIL ") + f + "  " + fpass + "/" + n);
}
console.log("\n" + pass + " passed, " + fail + " failed, " + (pass + fail) + " total");
process.exit(fail ? 1 : 0);
