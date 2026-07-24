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
  it("offers stash / edit / patch / open for a modified tracked file", () => {
    expect(uncommittedFileMenuActions(file("M"))).toEqual({
      stashFile: true,
      stopTracking: true,
      edit: true,
      deleteFile: false,
      createPatch: true,
      openDefaultApp: true,
    });
  });

  it("offers stash / edit / delete / patch / open but not stop-tracking for untracked", () => {
    expect(uncommittedFileMenuActions(file("U"))).toEqual({
      stashFile: true,
      stopTracking: false,
      edit: true,
      deleteFile: true,
      createPatch: true,
      openDefaultApp: true,
    });
  });

  it("hides stop-tracking, edit, and open-default for a deletion; still allows stash / patch", () => {
    expect(uncommittedFileMenuActions(file("D"))).toEqual({
      stashFile: true,
      stopTracking: false,
      edit: false,
      deleteFile: false,
      createPatch: true,
      openDefaultApp: false,
    });
  });

  it("defers every deferred verb for renames except edit / open-default", () => {
    expect(uncommittedFileMenuActions(file("R"))).toEqual({
      stashFile: false,
      stopTracking: false,
      edit: true,
      deleteFile: false,
      createPatch: false,
      openDefaultApp: true,
    });
  });

  it("hides every deferred verb for submodules", () => {
    expect(
      uncommittedFileMenuActions(file("M", { kind: "submodule", message: "Submodule" })),
    ).toEqual({
      stashFile: false,
      stopTracking: false,
      edit: false,
      deleteFile: false,
      createPatch: false,
      openDefaultApp: false,
    });
  });

  it("returns edit/open optimistic defaults when the entry is missing", () => {
    expect(uncommittedFileMenuActions(undefined)).toEqual({
      stashFile: false,
      stopTracking: false,
      edit: true,
      deleteFile: false,
      createPatch: false,
      openDefaultApp: true,
    });
  });
});
