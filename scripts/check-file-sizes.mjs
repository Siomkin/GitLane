// Enforces the size ceiling in docs/rules/architecture-rules-react.md §4a and
// -rust.md §6 as a ratchet: the tree already carries files over it, so the check
// fails on a *new* offender or on an existing one that grew, not on the backlog.
//
// Baseline lives in scripts/file-size-baseline.json — shrinking a file updates it
// (run with --update); growing one past its recorded size is the failure.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CEILING = 400;
const BASELINE = "scripts/file-size-baseline.json";
// Co-located tests get their own, looser ceiling and their own baseline. A test
// file legitimately runs longer than its subject — one `describe` per branch,
// fixtures inline — so holding it to 400 would flag most of the suite. But
// unbounded is what produced repo.test.ts at 5 122 lines, whose seams no longer
// match the store modules it covers. Splitting them is tracked separately from
// the production backlog, so the two baselines shrink independently.
const TEST_CEILING = 1200;
const TEST_BASELINE = "scripts/file-size-baseline.tests.json";
const IS_TEST = /\.test\.tsx?$/;
// Prop-only data, generated files, and declare-and-re-export facades (§4a).
//
// Listed by path, not by filename: a bare /types\.ts$/ exempted every file so
// named, including ones that only *declare* (github/types.ts is 240 lines of
// IPC shapes). §4a exempts the facade that re-exports, not the declarations.
const EXEMPT = [
  /^src\/components\/ui\/icons\.tsx$/,
  /^src\/lib\/api\/git\/types\.ts$/,
  /\/gen\//,
];

/** Lines that count. A Rust file's inline test module is measured separately
 *  from its production half; a co-located frontend test is measured whole, and
 *  scored against `TEST_CEILING` rather than `CEILING` (see `ceilingFor`).
 *
 *  The split keys on the `mod tests` that follows the attribute, not on
 *  `#[cfg(test)]` alone — plenty of production code carries a test-only `use`
 *  or helper, and splitting there counted the rest of the file as tests. */
export function countable(file, body) {
  if (!file.endsWith(".rs")) return { "": body.split("\n").length };
  const at = body.search(/\n#\[cfg\((?:test|all\(test[^)]*\))\)\]\nmod tests[\s;{]/);
  if (at === -1) return { "": body.split("\n").length };
  // `at` indexes the newline *before* the attribute, so the production half
  // ends there and the test half starts on the next line — slicing from `at`
  // for both would count that newline twice.
  return {
    "": body.slice(0, at).split("\n").length,
    " (tests)": body.slice(at + 1).split("\n").length,
  };
}

/** Tracked production sources the ratchet scores. Plain `*` pathspecs are
 *  recursive in git (a `*` matches `/`), so `'src-tauri/src/*.rs'` includes
 *  both `lib.rs` and `git/write/cli.rs`. The old `'**'` form is *not* glob
 *  magic unless prefixed `:(glob)` — git treated it as two `*`s and required
 *  a `/` after the prefix, which skipped every top-level file. */
export function trackedSources() {
  return execSync("git ls-files 'src/*.ts' 'src/*.tsx' 'src-tauri/src/*.rs'")
    .toString()
    .split("\n")
    .filter(Boolean)
    .filter((file) => !EXEMPT.some((pattern) => pattern.test(file)));
}

// Importing this module (the tests do) must not run the check.
if (process.argv[1]?.endsWith("check-file-sizes.mjs")) main();

function main() {
  const files = trackedSources();

  // Production and test offenders are ratcheted apart, against their own
  // ceiling and their own baseline file.
  const over = {};
  const overTests = {};
  for (const file of files) {
    const parts = countable(file, readFileSync(file, "utf8"));
    if (!parts) continue;
    const bucket = IS_TEST.test(file) ? overTests : over;
    const ceiling = ceilingFor(file);
    for (const [suffix, lines] of Object.entries(parts)) {
      if (lines > ceiling) bucket[file + suffix] = lines;
    }
  }

  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(over, null, 2)}\n`);
    writeFileSync(TEST_BASELINE, `${JSON.stringify(overTests, null, 2)}\n`);
    console.log(
      `Baseline updated: ${Object.keys(over).length} file(s) over ${CEILING} lines, ` +
        `${Object.keys(overTests).length} test file(s) over ${TEST_CEILING}.`,
    );
    process.exit(0);
  }

  const failed =
    report(over, BASELINE, CEILING, "") | report(overTests, TEST_BASELINE, TEST_CEILING, "test ");
  if (failed) {
    console.error("\nSee docs/rules/architecture-rules-react.md §4a / -rust.md §6.");
    process.exit(1);
  }
}

/** The ceiling a file is held to — co-located tests get the looser one. */
export function ceilingFor(file) {
  return IS_TEST.test(file) ? TEST_CEILING : CEILING;
}

/** Compare one bucket against its baseline; report and return 1 if any grew. */
function report(over, baselineFile, ceiling, label) {
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
  const grew = Object.entries(over).filter(([file, lines]) => lines > (baseline[file] ?? ceiling));
  const shrank = Object.entries(baseline).filter(([file, lines]) => (over[file] ?? 0) < lines);

  for (const [file, lines] of grew) {
    const was = baseline[file];
    console.error(
      was
        ? `✘ ${file}: ${lines} lines (was ${was}) — over the ${ceiling}-line ceiling and growing.`
        : `✘ ${file}: ${lines} lines — over the ${ceiling}-line ceiling. Split it into a folder module.`,
    );
  }
  if (grew.length) return 1;
  if (shrank.length) {
    console.log(`${shrank.length} ${label}file(s) shrank — run \`bun run sizes:update\` to ratchet.`);
  }
  console.log(
    `OK — ${Object.keys(over).length} known ${label}file(s) over ${ceiling} lines, none grew.`,
  );
  return 0;
}
