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
// Prop-only data, generated files, and declare-and-re-export facades (§4a).
//
// Listed by path, not by filename: a bare /types\.ts$/ exempted every file so
// named, including ones that only *declare* (github/types.ts is 240 lines of
// IPC shapes). §4a exempts the facade that re-exports, not the declarations.
const EXEMPT = [
  /^src\/components\/ui\/icons\.tsx$/,
  /^src\/lib\/api\/schemas\.ts$/,
  /^src\/lib\/api\/git\/types\.ts$/,
  /\/gen\//,
];

/** Lines that count: co-located frontend tests are excluded, and a Rust file's
 *  inline test module is measured separately from its production half.
 *
 *  The split keys on the `mod tests` that follows the attribute, not on
 *  `#[cfg(test)]` alone — plenty of production code carries a test-only `use`
 *  or helper, and splitting there counted the rest of the file as tests. */
export function countable(file, body) {
  if (/\.test\.tsx?$/.test(file)) return null;
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

// Importing this module (the tests do) must not run the check.
if (process.argv[1]?.endsWith("check-file-sizes.mjs")) main();

function main() {
  const files = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx' 'src-tauri/src/**/*.rs'")
    .toString()
    .split("\n")
    .filter(Boolean)
    .filter((file) => !EXEMPT.some((pattern) => pattern.test(file)));

  const over = {};
  for (const file of files) {
    const parts = countable(file, readFileSync(file, "utf8"));
    if (!parts) continue;
    for (const [suffix, lines] of Object.entries(parts)) {
      if (lines > CEILING) over[file + suffix] = lines;
    }
  }

  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(over, null, 2)}\n`);
    console.log(`Baseline updated: ${Object.keys(over).length} files over ${CEILING} lines.`);
    process.exit(0);
  }

  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  const grew = Object.entries(over).filter(([file, lines]) => lines > (baseline[file] ?? CEILING));
  const shrank = Object.entries(baseline).filter(([file, lines]) => (over[file] ?? 0) < lines);

  for (const [file, lines] of grew) {
    const was = baseline[file];
    console.error(
      was
        ? `✘ ${file}: ${lines} lines (was ${was}) — over the ${CEILING}-line ceiling and growing.`
        : `✘ ${file}: ${lines} lines — over the ${CEILING}-line ceiling. Split it into a folder module.`,
    );
  }
  if (grew.length) {
    console.error("\nSee docs/rules/architecture-rules-react.md §4a / -rust.md §6.");
    process.exit(1);
  }
  if (shrank.length) {
    console.log(`${shrank.length} file(s) shrank — run \`bun run sizes:update\` to ratchet.`);
  }
  console.log(`OK — ${Object.keys(over).length} known file(s) over ${CEILING} lines, none grew.`);
}
