import { describe, it, expect } from "vitest";
import type { FileChange } from "../../lib/api";
import { buildRows, type Row } from "./commitTree";

const fc = (path: string): FileChange => ({ path, status: "M", add: 0, del: 0, binary: false });
const all = () => true;
const none = () => false;

/** Find a directory row by key, narrowed to the `dir` variant. */
function dirRow(rows: Row[], key: string) {
  const row = rows.find((r) => r.kind === "dir" && r.key === key);
  if (!row || row.kind !== "dir") throw new Error(`no dir row for "${key}"`);
  return row;
}

describe("buildRows", () => {
  it("returns nothing for empty input", () => {
    expect(buildRows([], {}, all)).toEqual([]);
  });

  it("lists root-level files sorted by basename, at depth 0", () => {
    const rows = buildRows([fc("b.ts"), fc("a.ts")], {}, all);
    expect(rows.map((r) => r.kind)).toEqual(["file", "file"]);
    expect(rows.map((r) => r.key)).toEqual(["a.ts", "b.ts"]);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  it("groups files into directories: dirs before files, dir then its children", () => {
    const rows = buildRows([fc("src/a.ts"), fc("readme.md")], {}, all);
    expect(rows.map((r) => [r.kind, r.key, r.depth])).toEqual([
      ["dir", "src", 0],
      ["file", "src/a.ts", 1],
      ["file", "readme.md", 0],
    ]);
  });

  it("orders sibling directories alphabetically, files after dirs", () => {
    const rows = buildRows([fc("b/x.ts"), fc("a/y.ts"), fc("z.ts")], {}, all);
    expect(rows.map((r) => r.key)).toEqual(["a", "a/y.ts", "b", "b/x.ts", "z.ts"]);
  });

  it("collapses single-child directory chains into one header", () => {
    const rows = buildRows([fc("a/b/c/file.ts")], {}, all);
    const dir = dirRow(rows, "a/b/c");
    expect(dir.label).toBe("a/b/c");
    expect(dir.depth).toBe(0);
    expect(dir.count).toBe(1);
    expect(rows.map((r) => [r.kind, r.key])).toEqual([
      ["dir", "a/b/c"],
      ["file", "a/b/c/file.ts"],
    ]);
  });

  it("rolls the included predicate up to on/off/mixed per directory", () => {
    const files = [fc("d/a.ts"), fc("d/b.ts")];
    expect(dirRow(buildRows(files, {}, all), "d").state).toBe("on");
    expect(dirRow(buildRows(files, {}, none), "d").state).toBe("off");
    expect(dirRow(buildRows(files, {}, (p) => p === "d/a.ts"), "d").state).toBe("mixed");
  });

  it("reports a directory's descendant count and paths", () => {
    const dir = dirRow(buildRows([fc("d/a.ts"), fc("d/b.ts")], {}, all), "d");
    expect(dir.count).toBe(2);
    expect([...dir.paths].sort()).toEqual(["d/a.ts", "d/b.ts"]);
  });

  it("hides descendants when a directory is collapsed", () => {
    const files = [fc("d/a.ts"), fc("d/b.ts")];
    const collapsed = buildRows(files, { d: true }, all);
    expect(collapsed.map((r) => r.kind)).toEqual(["dir"]);
    expect(dirRow(collapsed, "d").collapsed).toBe(true);

    const expanded = buildRows(files, {}, all);
    expect(expanded.filter((r) => r.kind === "file").map((r) => r.key)).toEqual([
      "d/a.ts",
      "d/b.ts",
    ]);
  });
});
