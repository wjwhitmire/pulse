// Static check: every network call in the page goes through the gate. Removes the bodies of the
// gate functions (net, netScript, netStyle, netImport) from the page scripts and asserts that no
// network API is mentioned anywhere else. Run: node web/net.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "app.html"), "utf8");
const scripts = [...html.matchAll(/<script id="(\w+)">([\s\S]*?)<\/script>/g)];
let fails = 0;
function stripFunction(src, name) {
  const re = new RegExp("(async\\s+)?function " + name + "\\s*\\(");
  const m = re.exec(src);
  if (!m) { console.error("FAIL gate function missing: " + name); fails++; return src; }
  let i = src.indexOf("{", m.index), depth = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === "{") depth++; else if (src[j] === "}") { depth--; if (depth === 0) break; } }
  return src.slice(0, m.index) + src.slice(j + 1);
}
const NET = [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /\bEventSource\b/, /sendBeacon/, /importScripts/, /\bimport\s*\(/, /\.src\s*=/, /\.href\s*=(?!\s*url;)/];
for (const [, id, src0] of scripts) {
  let src = src0;
  if (id === "ui") for (const f of ["net", "netScript", "netStyle", "netImport"]) src = stripFunction(src, f);
  // the export link is a local object URL; it is assigned from a variable named url
  for (const re of NET) {
    const m = re.exec(src);
    if (m) { fails++; console.error(`FAIL ${id}: network API outside the gate: ${src.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\s+/g, " ")}`); }
  }
}
const html2 = html.replace(/<script id="\w+">[\s\S]*?<\/script>/g, "");
const ext = [...html2.matchAll(/(src|href)="(https?:[^"]+)"/g)].map((m) => m[2]);
for (const u of ext) if (!u.startsWith("https://fonts.googleapis.com/")) { fails++; console.error("FAIL external resource in markup: " + u); }
console.log(fails ? `${fails} failures` : `network gate check passed (${scripts.length} scripts, ${ext.length} external stylesheet)`);
process.exit(fails ? 1 : 0);
