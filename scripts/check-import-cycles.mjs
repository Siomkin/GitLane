// Enforces "no new runtime import cycle" (docs/rules/architecture-rules-react.md
// §1 "Import direction") as a ratchet, the same way check-file-sizes.mjs enforces
// the size ceiling: the tree already carries one cycle, so the check fails when a
// file *joins* a cycle, not on the backlog.
//
// The metric is strongly-connected-component membership, not a cycle count: the
// number of distinct cycles through one knot depends on traversal order, while
// "is this file part of a cycle" is deterministic and is the question a review
// needs answered.
//
// Baseline lives in scripts/import-cycle-baseline.json — untangling a file
// updates it (run with --update); a file outside it landing in a cycle fails.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";

const BASELINE = "scripts/import-cycle-baseline.json";
// Tests mock the boundary and may import anything; ambient declarations import
// nothing at runtime.
const NOT_SCORED = [/\.test\.tsx?$/, /^src\/test\//, /\.d\.ts$/];
// A static `import … from "x"`, side-effect `import "x"`, or re-export
// `export … from "x"`. Group 1 is set for `import type` / `export type`, which
// TypeScript erases — no runtime edge. `[^;'"]` spans newlines, so a multi-line
// specifier list is one match. Dynamic `import()` is deliberately not an edge:
// it cannot deadlock module evaluation.
const IMPORT = /^(?:import|export)\s+(type\s+)?(?:[^;'"]*?\sfrom\s+)?["']([^"']+)["']/gm;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** Tracked frontend sources the ratchet scores (plain `*` pathspecs are
 *  recursive in git — see check-file-sizes.mjs). */
export function trackedSources() {
  return execSync("git ls-files 'src/*.ts' 'src/*.tsx'")
    .toString()
    .split("\n")
    .filter(Boolean)
    .filter((file) => !NOT_SCORED.some((pattern) => pattern.test(file)));
}

/** Runtime import edges between the given sources: `Map<file, file[]>`.
 *  `sources` maps a repo-relative path to its text. Lint bans `../`
 *  (PARENT_RELATIVE_IMPORT), so an in-repo specifier is `@/…` or `./…`; anything
 *  else is a package and not an edge. */
export function importGraph(sources) {
  const resolve = (from, specifier) => {
    const base = specifier.startsWith("@/")
      ? `src/${specifier.slice(2)}`
      : specifier.startsWith(".")
        ? posix.normalize(posix.join(posix.dirname(from), specifier))
        : null;
    if (!base) return null;
    return RESOLVE_SUFFIXES.map((suffix) => base + suffix).find((path) => sources.has(path)) ?? null;
  };

  const graph = new Map();
  for (const [file, body] of sources) {
    const targets = new Set();
    for (const [, typeOnly, specifier] of body.matchAll(IMPORT)) {
      if (typeOnly) continue;
      const target = resolve(file, specifier);
      if (target && target !== file) targets.add(target);
    }
    graph.set(file, [...targets]);
  }
  return graph;
}

/** Every file that sits in a strongly connected component of size > 1 (Tarjan),
 *  sorted. Empty when the graph is a DAG. */
export function cycleMembers(graph) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const members = [];

  const visit = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component = [];
    let popped;
    do {
      popped = stack.pop();
      onStack.delete(popped);
      component.push(popped);
    } while (popped !== node);
    if (component.length > 1) members.push(...component);
  };

  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return members.sort();
}

// Importing this module (the tests do) must not run the check.
if (process.argv[1]?.endsWith("check-import-cycles.mjs")) main();

function main() {
  const sources = new Map(trackedSources().map((file) => [file, readFileSync(file, "utf8")]));
  const inCycle = cycleMembers(importGraph(sources));

  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(inCycle, null, 2)}\n`);
    console.log(`Baseline updated: ${inCycle.length} file(s) in import cycles.`);
    process.exit(0);
  }

  const baseline = new Set(JSON.parse(readFileSync(BASELINE, "utf8")));
  const added = inCycle.filter((file) => !baseline.has(file));
  for (const file of added) {
    console.error(`✘ ${file}: now part of a runtime import cycle.`);
  }
  if (added.length) {
    console.error(
      "\nA module it imports leads back to it. Import downward only, or move the shared piece to a" +
        "\nlower layer — see docs/rules/architecture-rules-react.md §1 (Import direction).",
    );
    process.exit(1);
  }

  const left = [...baseline].filter((file) => !inCycle.includes(file));
  if (left.length) {
    console.log(`${left.length} file(s) left the cycle — run \`bun run cycles:update\` to ratchet.`);
  }
  console.log(`OK — ${inCycle.length} known file(s) in import cycles, none added.`);
}
