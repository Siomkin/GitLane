// The size checker's one piece of real logic: where a Rust file's production
// half ends and its test module begins.
//
// It used to split at the first `#[cfg(test)]`, which in plenty of files is a
// test-only `use` or helper hundreds of lines above the test module — so the
// rest of the file was scored as tests and its production half went unmeasured.
// Eight files were over the ceiling behind that. These cases pin the fix.

import { describe, expect, it } from "vitest";

import { ceilingFor, countable, trackedSources } from "./check-file-sizes.mjs";

const lines = (...body: string[]) => `${body.join("\n")}\n`;

describe("countable", () => {
  it("scores a Rust file with no test module as all production", () => {
    const body = lines("pub fn a() {}", "pub fn b() {}");

    expect(countable("src-tauri/src/git/x.rs", body)).toEqual({ "": 3 });
  });

  it("splits at the test module, not at an earlier test-only use", () => {
    // git/write/cli.rs's shape: a `#[cfg(test)] use` on line 2, its test module
    // hundreds of lines below. Splitting at the attribute scored line 3 onward
    // as tests and left the production half invisible.
    const body = lines(
      "//! Module doc.",
      "#[cfg(test)]",
      "use crate::testing::Fixture;",
      "",
      "pub fn production() {}",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn t() {}",
      "}",
    );

    expect(countable("src-tauri/src/git/write/cli.rs", body)).toEqual({
      "": 6,
      " (tests)": 6,
    });
  });

  it("splits at a cfg(all(test, ..)) test module too", () => {
    // Three modules in the tree gate on the platform as well.
    const body = lines("pub fn production() {}", "", "#[cfg(all(test, unix))]", "mod tests {", "}");

    expect(countable("src-tauri/src/git/write/cli.rs", body)).toEqual({
      "": 2,
      " (tests)": 4,
    });
  });

  it("splits at an out-of-line `mod tests;` declaration", () => {
    const body = lines("pub fn production() {}", "", "#[cfg(test)]", "mod tests;");

    expect(countable("src-tauri/src/watcher/x.rs", body)).toEqual({
      "": 2,
      " (tests)": 3,
    });
  });

  it("does not split on a test-only item that merely starts with `mod tests`", () => {
    const body = lines("pub fn production() {}", "", "#[cfg(test)]", "mod tests_support {", "}");

    expect(countable("src-tauri/src/git/x.rs", body)).toEqual({ "": 6 });
  });

  it("counts a whole TypeScript file, test modules being a Rust concern", () => {
    const body = lines("export const a = 1;", "export const b = 2;");

    expect(countable("src/store/x.ts", body)).toEqual({ "": 3 });
  });

  it("counts co-located frontend tests, which are scored against TEST_CEILING", () => {
    const body = lines("it('works', () => {});");

    expect(countable("src/store/x.test.ts", body)).toEqual({ "": 2 });
    expect(countable("src/components/X.test.tsx", body)).toEqual({ "": 2 });
  });
});

describe("trackedSources", () => {
  it("scores top-level files that the old ** pathspec skipped", () => {
    const list = trackedSources();

    expect(list).toContain("src-tauri/src/lib.rs");
    expect(list).toContain("src/App.tsx");
  });

  it("excludes EXEMPT paths", () => {
    const list = trackedSources();

    expect(list).not.toContain("src/components/ui/icons.tsx");
    expect(list).not.toContain("src/lib/api/git/types.ts");
  });
});

describe("ceilingFor", () => {
  it("holds co-located tests to the looser test ceiling", () => {
    expect(ceilingFor("src/store/x.test.ts")).toBe(1200);
    expect(ceilingFor("src/components/X.test.tsx")).toBe(1200);
  });

  it("holds everything else to the production ceiling", () => {
    expect(ceilingFor("src/store/x.ts")).toBe(400);
    expect(ceilingFor("src-tauri/src/git/x.rs")).toBe(400);
    // Not a co-located test: the shared harness under src/test/ is production
    // code for the suite and stays on the 400-line ceiling.
    expect(ceilingFor("src/test/setup.ts")).toBe(400);
  });
});
