import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { fileViewEditBlockedReason, isFileViewEditable } from "./repoFilesActions";
import type { FileViewState } from "./repoTypes";

const view = {
  path: "README.md",
  loading: false,
  error: null,
  content: { text: "hello\n", binary: false, truncated: false, expectedState: "s1", size: 6 },
} as unknown as FileViewState;

describe("editing files of a remote repository", () => {
  it("a local text file is editable", () => {
    expect(isFileViewEditable(view, "/repo")).toBe(true);
    expect(fileViewEditBlockedReason(view, "/repo")).toBeNull();
  });

  it("a file in a repository opened over SSH opens read-only, with the reason", () => {
    expect(isFileViewEditable(view, "ssh://devbox/srv/app")).toBe(false);
    expect(fileViewEditBlockedReason(view, "ssh://devbox/srv/app")).toBe(
      "Files in a remote repository open read-only",
    );
  });
});
