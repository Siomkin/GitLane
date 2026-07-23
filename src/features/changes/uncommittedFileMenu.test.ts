import { describe, expect, it } from "vitest";
import type { FileChange } from "@/lib/api";
import { uncommittedFileMenuActions } from "./uncommittedFileMenu";

const file = (status: FileChange["status"], advanced?: FileChange["advanced"]): FileChange => ({
  path: "src/a.ts",
  status,
  add: 1,
  del: 0,
  binary: false,
  advanced,
});

describe("uncommittedFileMenuActions", () => {
  it("offers stash / patch / open / difftool for a modified tracked file", () => {
    expect(uncommittedFileMenuActions(file("M"))).toEqual({
      stashFile: true,
      stopTracking: true,
      createPatch: true,
      openDefaultApp: true,
      openDiffTool: true,
    });
  });

  it("offers stash / delete-style patch / open but not stop-tracking or difftool for untracked", () => {
    expect(uncommittedFileMenuActions(file("U"))).toEqual({
      stashFile: true,
      stopTracking: false,
      createPatch: true,
      openDefaultApp: true,
      openDiffTool: false,
    });
  });

  it("hides stop-tracking and open-default for a deletion; still allows stash / patch / difftool", () => {
    expect(uncommittedFileMenuActions(file("D"))).toEqual({
      stashFile: true,
      stopTracking: false,
      createPatch: true,
      openDefaultApp: false,
      openDiffTool: true,
    });
  });

  it("defers every deferred verb for renames", () => {
    expect(uncommittedFileMenuActions(file("R"))).toEqual({
      stashFile: false,
      stopTracking: false,
      createPatch: false,
      openDefaultApp: true,
      openDiffTool: false,
    });
  });

  it("hides every deferred verb for submodules", () => {
    expect(
      uncommittedFileMenuActions(file("M", { kind: "submodule", message: "Submodule" })),
    ).toEqual({
      stashFile: false,
      stopTracking: false,
      createPatch: false,
      openDefaultApp: false,
      openDiffTool: false,
    });
  });

  it("returns all-false when the entry is missing", () => {
    expect(uncommittedFileMenuActions(undefined).stashFile).toBe(false);
  });
});
