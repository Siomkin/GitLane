import { describe, expect, it } from "vitest";
import type { WorkingChanges } from "./api";
import {
  advancedFileGuard,
  advancedNotices,
  fileWriteGuard,
  guardedAdvancedWriteMessage,
} from "./advancedRepoState";

describe("advancedRepoState", () => {
  it("summarizes sparse, LFS, and submodule state", () => {
    const changes: WorkingChanges = {
      staged: [],
      unstaged: [],
      conflicted: [],
      advanced: {
        submodules: [
          {
            path: "deps/lib",
            name: "deps/lib",
            url: "https://example.test/lib.git",
            status: "not initialized",
            details: ["not initialized"],
            dirty: true,
            initialized: false,
          },
        ],
        lfs: {
          detected: true,
          installed: false,
          issues: ["Git LFS is needed for changed or missing LFS-managed files, but git-lfs was not found on PATH."],
          patterns: ["*.bin"],
        },
        sparseCheckout: { enabled: true, mode: "cone", patterns: ["src/"] },
      },
    };

    expect(advancedNotices(changes)).toEqual([
      "1 submodule has changes. Use git submodule commands or the terminal to update submodule internals.",
      "Git LFS is needed for changed or missing LFS-managed files, but git-lfs was not found on PATH.",
      "Sparse checkout is enabled. The working tree is limited to selected paths; committed files outside the sparse set can still appear in history.",
    ]);
  });

  it("does not show LFS just because patterns are configured", () => {
    const changes: WorkingChanges = {
      staged: [],
      unstaged: [],
      conflicted: [],
      advanced: {
        submodules: [],
        lfs: { detected: true, installed: false, issues: [], patterns: ["*.bin"] },
        sparseCheckout: { enabled: false, mode: null, patterns: [] },
      },
    };

    expect(advancedNotices(changes)).toEqual([]);
    expect(guardedAdvancedWriteMessage(changes)).toBeNull();
  });

  it("guards advanced file writes", () => {
    const changes: WorkingChanges = {
      staged: [],
      unstaged: [
        {
          path: "deps/lib",
          status: "M",
          add: 0,
          del: 0,
          binary: false,
          advanced: { kind: "submodule", message: "Submodule: not initialized" },
        },
      ],
      conflicted: [],
    };

    expect(advancedFileGuard(changes.unstaged[0])).toBe(
      "Submodule: not initialized. Use the terminal for submodule updates.",
    );
    expect(guardedAdvancedWriteMessage(changes)).toBe(
      "Submodule: not initialized. Use the terminal for submodule updates.",
    );
  });

  it("guards sparse checkout paths that git add would reject", () => {
    const changes: WorkingChanges = {
      staged: [],
      unstaged: [
        {
          path: "docs/hidden.txt",
          status: "M",
          add: 1,
          del: 1,
          binary: false,
          advanced: { kind: "sparse", message: "Outside sparse checkout" },
        },
      ],
      conflicted: [],
    };

    expect(advancedFileGuard(changes.unstaged[0])).toBe(
      "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.",
    );
    expect(guardedAdvancedWriteMessage(changes)).toBe(
      "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.",
    );
  });

  it("guards visible files outside sparse checkout patterns even without backend annotation", () => {
    const changes: WorkingChanges = {
      staged: [],
      unstaged: [
        { path: "docs/hidden.txt", status: "M", add: 1, del: 1, binary: false },
        { path: "src/visible.txt", status: "M", add: 1, del: 0, binary: false },
      ],
      conflicted: [],
      advanced: {
        submodules: [],
        lfs: { detected: false, installed: null, issues: [], patterns: [] },
        sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"] },
      },
    };

    expect(fileWriteGuard(changes.unstaged[0], changes)).toBe(
      "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.",
    );
    expect(fileWriteGuard(changes.unstaged[1], changes)).toBeNull();
    expect(guardedAdvancedWriteMessage(changes)).toBe(
      "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.",
    );
  });

  it("accepts cone sparse checkout directory patterns", () => {
    const changes: WorkingChanges = {
      staged: [],
      unstaged: [{ path: "src/visible.txt", status: "M", add: 1, del: 0, binary: false }],
      conflicted: [],
      advanced: {
        submodules: [],
        lfs: { detected: false, installed: null, issues: [], patterns: [] },
        sparseCheckout: { enabled: true, mode: "cone", patterns: ["src/"] },
      },
    };

    expect(fileWriteGuard(changes.unstaged[0], changes)).toBeNull();
  });

  it("does not block writes only because repo-level notices are present", () => {
    const changes: WorkingChanges = {
      staged: [],
      unstaged: [{ path: "src/visible.txt", status: "M", add: 1, del: 0, binary: false }],
      conflicted: [],
      advanced: {
        submodules: [],
        lfs: { detected: false, installed: null, issues: [], patterns: [] },
        sparseCheckout: { enabled: true, mode: "cone", patterns: ["src/"] },
      },
    };

    expect(fileWriteGuard(changes.unstaged[0], changes)).toBeNull();
    expect(guardedAdvancedWriteMessage(changes)).toBeNull();
  });

  it("keeps LFS issues informational unless a file has an explicit guard", () => {
    const changes: WorkingChanges = {
      staged: [],
      unstaged: [{ path: "asset.bin", status: "M", add: 1, del: 0, binary: false }],
      conflicted: [],
      advanced: {
        submodules: [],
        lfs: {
          detected: true,
          installed: false,
          issues: ["asset.bin is still an LFS pointer. Run git lfs pull to download the real file content."],
          patterns: ["*.bin"],
        },
        sparseCheckout: { enabled: false, mode: null, patterns: [] },
      },
    };

    expect(advancedNotices(changes)).toEqual([
      "asset.bin is still an LFS pointer. Run git lfs pull to download the real file content.",
    ]);
    expect(fileWriteGuard(changes.unstaged[0], changes)).toBeNull();
    expect(guardedAdvancedWriteMessage(changes)).toBeNull();
  });

  it("guards bulk writes for dirty submodule metadata even without a file row", () => {
    const changes: WorkingChanges = {
      staged: [],
      unstaged: [],
      conflicted: [],
      advanced: {
        submodules: [
          {
            path: "deps/child",
            name: "deps/child",
            url: null,
            status: "modified files inside submodule",
            details: ["modified files inside submodule"],
            dirty: true,
            initialized: true,
          },
        ],
        lfs: { detected: false, installed: null, issues: [], patterns: [] },
        sparseCheckout: { enabled: false, mode: null, patterns: [] },
      },
    };

    expect(guardedAdvancedWriteMessage(changes)).toBe(
      "Submodule: modified files inside submodule. Use the terminal for submodule updates.",
    );
  });
});
