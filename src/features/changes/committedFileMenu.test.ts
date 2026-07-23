import { describe, expect, it } from "vitest";
import type { FileChange } from "@/lib/api";
import { canRestoreCommittedFile } from "./committedFileMenu";

const file = (over: Partial<FileChange>): FileChange => ({
  path: "a.ts",
  status: "M",
  add: 1,
  del: 0,
  binary: false,
  ...over,
});

describe("canRestoreCommittedFile", () => {
  it("allows a modified file with a commit oid", () => {
    expect(canRestoreCommittedFile(file({ status: "M" }), "abc")).toBe(true);
  });

  it("hides Restore for deletes, submodules, and missing oid", () => {
    expect(canRestoreCommittedFile(file({ status: "D" }), "abc")).toBe(false);
    expect(
      canRestoreCommittedFile(
        file({ advanced: { kind: "submodule", message: "submodule" } }),
        "abc",
      ),
    ).toBe(false);
    expect(canRestoreCommittedFile(file({}), undefined)).toBe(false);
    expect(canRestoreCommittedFile(undefined, "abc")).toBe(false);
  });
});
