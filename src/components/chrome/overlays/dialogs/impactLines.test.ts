import { describe, expect, it } from "vitest";
import { middleEllipsis, parseImpactLines } from "./impactLines";

describe("middleEllipsis", () => {
  it("keeps short names and cuts long ones in the middle to the max length", () => {
    expect(middleEllipsis("main")).toBe("main");
    const long = "feature/payments-provider-migration-with-retry-backoff-v2";
    const cut = middleEllipsis(long);
    expect(cut).toHaveLength(46);
    expect(cut.startsWith("feature/payments")).toBe(true);
    expect(cut.endsWith("retry-backoff-v2")).toBe(true);
  });
});

describe("parseImpactLines", () => {
  it("turns a push_list file section into a counted header, file rows and a more row", () => {
    expect(
      parseImpactLines([
        "Discard every change",
        "Files that will be reset or removed:",
        " M src/a.ts",
        "?? notes.txt",
        "R  old.ts -> new.ts",
        "… and 3 more",
      ]),
    ).toEqual([
      { kind: "text", text: "Discard every change" },
      { kind: "head", text: "Files that will be reset or removed", count: 6 },
      { kind: "file", status: "M", path: "src/a.ts" },
      { kind: "file", status: "U", path: "notes.txt" },
      { kind: "file", status: "R", path: "old.ts -> new.ts" },
      { kind: "more", text: "… and 3 more" },
    ]);
  });

  it("never reads status lines outside a section", () => {
    expect(parseImpactLines(["MM looks like status"])).toEqual([
      { kind: "text", text: "MM looks like status" },
    ]);
  });

  it("keeps non-file section items as text but still counts them", () => {
    expect(parseImpactLines(["Commits:", "abc1234 fix it"])).toEqual([
      { kind: "head", text: "Commits", count: 1 },
      { kind: "text", text: "abc1234 fix it" },
    ]);
  });
});
