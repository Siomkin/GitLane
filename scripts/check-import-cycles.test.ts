// The cycle checker's real logic: which statements are runtime import edges,
// how a specifier resolves to a tracked file, and which files sit in a cycle.
//
// The distinction that matters is value vs type imports — a type-only cycle is
// erased by TypeScript and harmless, and scoring it would bury the one real knot
// (src/store) under dozens of lib/api schema files that only share types.

import { describe, expect, it } from "vitest";

import { cycleMembers, importGraph, trackedSources } from "./check-import-cycles.mjs";

const sources = (files: Record<string, string>) => new Map(Object.entries(files));
const inCycle = (files: Record<string, string>) => cycleMembers(importGraph(sources(files)));

describe("importGraph", () => {
  it("resolves @/ and ./ specifiers to .ts, .tsx and /index.ts files", () => {
    const graph = importGraph(
      sources({
        "src/store/a.ts": [
          'import { b } from "./b";',
          'import { View } from "@/features/view";',
          'import { c } from "@/lib/c";',
        ].join("\n"),
        "src/store/b.ts": "",
        "src/features/view.tsx": "",
        "src/lib/c/index.ts": "",
      }),
    );

    expect(graph.get("src/store/a.ts")).toEqual([
      "src/store/b.ts",
      "src/features/view.tsx",
      "src/lib/c/index.ts",
    ]);
  });

  it("ignores packages and specifiers that resolve to no tracked file", () => {
    const graph = importGraph(
      sources({
        "src/a.ts": 'import { create } from "zustand";\nimport "./styles.css";\nimport x from "./gone";',
      }),
    );

    expect(graph.get("src/a.ts")).toEqual([]);
  });

  it("counts a multi-line import, a side-effect import and a re-export as edges", () => {
    const graph = importGraph(
      sources({
        "src/a.ts": ['import {', "  one,", "  two,", '} from "./b";', 'import "./c";', 'export { d } from "./d";', 'export * from "./e";'].join("\n"),
        "src/b.ts": "",
        "src/c.ts": "",
        "src/d.ts": "",
        "src/e.ts": "",
      }),
    );

    expect(graph.get("src/a.ts")).toEqual(["src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
  });

  it("does not count import type / export type — they are erased", () => {
    const graph = importGraph(
      sources({
        "src/a.ts": 'import type { B } from "./b";\nexport type { B2 } from "./b";',
        "src/b.ts": "",
      }),
    );

    expect(graph.get("src/a.ts")).toEqual([]);
  });

  it("does not mistake an exported string constant for a re-export", () => {
    const graph = importGraph(sources({ "src/a.ts": 'export const NAME = "./b";', "src/b.ts": "" }));

    expect(graph.get("src/a.ts")).toEqual([]);
  });
});

describe("cycleMembers", () => {
  it("reports both files of a two-file value cycle", () => {
    expect(
      inCycle({
        "src/store/ui.ts": 'import { useRepo } from "./repo";',
        "src/store/repo.ts": 'import { useUi } from "./ui";',
      }),
    ).toEqual(["src/store/repo.ts", "src/store/ui.ts"]);
  });

  it("reports nothing when the back-edge is type-only", () => {
    expect(
      inCycle({
        "src/store/ui.ts": 'import type { RepoState } from "./repo";',
        "src/store/repo.ts": 'import { useUi } from "./ui";',
      }),
    ).toEqual([]);
  });

  it("reports every file of a longer cycle but not what merely hangs off it", () => {
    expect(
      inCycle({
        "src/a.ts": 'import "./b";',
        "src/b.ts": 'import "./c";',
        "src/c.ts": 'import "./a";\nimport "./leaf";',
        "src/leaf.ts": "",
        "src/entry.ts": 'import "./a";',
      }),
    ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("reports nothing for a DAG", () => {
    expect(inCycle({ "src/a.ts": 'import "./b";\nimport "./c";', "src/b.ts": 'import "./c";', "src/c.ts": "" })).toEqual([]);
  });
});

describe("trackedSources", () => {
  it("scores frontend sources, top-level ones included", () => {
    const files = trackedSources();

    expect(files).toContain("src/App.tsx");
    expect(files).toContain("src/store/repo.ts");
  });

  it("leaves out tests, the test harness and ambient declarations", () => {
    const files = trackedSources();

    expect(files.some((file) => /\.test\.tsx?$/.test(file))).toBe(false);
    expect(files.some((file) => file.startsWith("src/test/"))).toBe(false);
    expect(files).not.toContain("src/vite-env.d.ts");
  });
});
