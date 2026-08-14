// The size checker's one piece of real logic: where a Rust file's production
// half ends and its test module begins.
//
// It used to split at the first `#[cfg(test)]`, which in plenty of files is a
// test-only `use` or helper hundreds of lines above the test module — so the
// rest of the file was scored as tests and its production half went unmeasured.
// Eight files were over the ceiling behind that. These cases pin the fix.

import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain .mjs build script, no types
import { countable } from "./check-file-sizes.mjs";

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

  it("skips co-located frontend tests entirely", () => {
    expect(countable("src/store/x.test.ts", "anything")).toBeNull();
    expect(countable("src/components/X.test.tsx", "anything")).toBeNull();
  });
});
