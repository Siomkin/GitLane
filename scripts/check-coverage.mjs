// Per-file line-coverage ratchet, the same shape as check-file-sizes.mjs: a file
// may not drop below its recorded coverage, and a file the baseline has never
// seen must meet FLOOR. Improvements are recorded only by an explicit
// `bun run coverage:update` on a green run, never by CI.
//
// Reads coverage/coverage-summary.json, written by `bun run test:coverage`.

import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

import { EXEMPT } from "./check-file-sizes.mjs";

const SUMMARY = "coverage/coverage-summary.json";
const BASELINE = "scripts/coverage-baseline.json";
export const FLOOR = 60;

/** `{ "src/x.ts": 87.5 }` from a json-summary report, exempt paths dropped. */
export function lineCoverage(summary, root = process.cwd()) {
  const out = {};
  for (const [file, totals] of Object.entries(summary)) {
    if (file === "total") continue;
    const path = relative(root, file).split("\\").join("/");
    if (EXEMPT.some((pattern) => pattern.test(path))) continue;
    out[path] = Math.round(totals.lines.pct * 10) / 10;
  }
  return out;
}

/** Files below their baseline, new files below FLOOR, and files that improved. */
export function compare(current, baseline, floor = FLOOR) {
  const regressed = [];
  const belowFloor = [];
  const improved = [];
  for (const [file, pct] of Object.entries(current)) {
    const was = baseline[file];
    if (was === undefined) {
      if (pct < floor) belowFloor.push([file, pct]);
    } else if (pct < was) {
      regressed.push([file, pct, was]);
    } else if (pct > was) {
      improved.push([file, pct, was]);
    }
  }
  return { regressed, belowFloor, improved };
}

// Importing this module (the tests do) must not run the check.
if (process.argv[1]?.endsWith("check-coverage.mjs")) main();

function main() {
  const current = lineCoverage(JSON.parse(readFileSync(SUMMARY, "utf8")));

  if (process.argv.includes("--update")) {
    const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`Baseline updated: ${Object.keys(sorted).length} file(s).`);
    return;
  }

  const { regressed, belowFloor, improved } = compare(current, JSON.parse(readFileSync(BASELINE, "utf8")));
  for (const [file, pct, was] of regressed) {
    console.error(`✘ ${file}: ${pct}% lines (was ${was}%) — coverage dropped.`);
  }
  for (const [file, pct] of belowFloor) {
    console.error(`✘ ${file}: ${pct}% lines — a new file needs at least ${FLOOR}%.`);
  }
  if (regressed.length || belowFloor.length) {
    console.error(
      "\nAdd tests, or accept the drop deliberately with `bun run coverage:update`. " +
        "A moved file needs its baseline key renamed in the same change (src/test/README.md).",
    );
    process.exit(1);
  }
  if (improved.length) {
    console.log(`${improved.length} file(s) improved — run \`bun run coverage:update\` to ratchet.`);
  }
  console.log(`OK — ${Object.keys(current).length} file(s) measured, none regressed.`);
}
