// Minimal test harness. Each module is loaded into a fresh node:vm context,
// exactly as the app inlines it: a plain script that defines one global.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const libDir = path.resolve(here, "..");

const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }
export function registered() { return tests; }

// Load lib/<file> into an isolated context with no Node globals, no fetch,
// no require. Returns the named global the script defines.
export function load(file, globalName) {
  const src = fs.readFileSync(path.join(libDir, file), "utf8");
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx, { filename: file, timeout: 5000 });
  const g = ctx[globalName];
  if (!g) throw new Error(file + " did not define " + globalName);
  return g;
}

export function fixture(name) { return fs.readFileSync(path.join(here, "fixtures", name), "utf8"); }

// Objects created inside the vm context have a different Object.prototype,
// so deep comparisons go through JSON first.
export function same(actual, expected, msg) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), msg);
}
export function near(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new assert.AssertionError({ message: (msg ? msg + ": " : "") + "expected " + expected + " +/- " + tol + ", got " + actual, actual, expected, operator: "near" });
  }
}
export function throwsCode(fn, code, msg) {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  if (!caught) throw new assert.AssertionError({ message: (msg || "expected throw") + " (code " + code + ")", operator: "throwsCode" });
  if (code && caught.code !== code) throw new assert.AssertionError({ message: (msg || "wrong error code") + ": expected " + code + ", got " + caught.code + " (" + caught.message + ")", operator: "throwsCode" });
  return caught;
}
export function noEmDash(s, msg) { assert.ok(!/\u2014/.test(s), (msg || "text") + " contains an em dash"); }

// Deterministic PRNG for synthetic data.
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { assert };
