import { describe, expect, it } from "vitest";
import type { FileChange, WorkingChanges } from "./api";
import {
  advancedFileGuard,
  advancedNotices,
  discardAllGuardMessage,
  emptyAdvancedState,
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

  it("warns that sparse guards are best-effort when the pattern list is truncated", () => {
    const changes: WorkingChanges = {
      staged: [],
      unstaged: [],
      conflicted: [],
      advanced: {
        submodules: [],
        lfs: { detected: false, installed: null, issues: [], patterns: [] },
        sparseCheckout: { enabled: true, mode: "pattern", patterns: ["/src/"], truncated: true },
      },
    };

    expect(advancedNotices(changes)).toEqual([
      "Sparse checkout is enabled. The working tree is limited to selected paths; committed files outside the sparse set can still appear in history.",
      "This sparse checkout has more patterns than GitLane inspects, so some outside-checkout warnings may be missing. Git still applies the sparse rules when you stage or commit.",
    ]);
  });

  it("omits the truncation notice when the pattern list is complete", () => {
    const changes: WorkingChanges = {
      staged: [],
      unstaged: [],
      conflicted: [],
      advanced: {
        submodules: [],
        lfs: { detected: false, installed: null, issues: [], patterns: [] },
        sparseCheckout: { enabled: true, mode: "cone", patterns: ["/src/"], truncated: false },
      },
    };

    expect(advancedNotices(changes)).toEqual([
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
      advanced: emptyAdvancedState,
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
      advanced: emptyAdvancedState,
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

  it("does not block valid writes when the backend truncated the pattern list", () => {
    // The backend capped a long sparse-checkout file, so a path missing from the
    // partial set may still be included by a pattern we never received. Blocking
    // it would falsely reject a stage/commit that git would accept.
    const insideButUnsent: FileChange = {
      path: "packages/forty-second/file.ts",
      status: "M",
      add: 1,
      del: 0,
      binary: false,
    };
    const authoritativelyOutside: FileChange = {
      path: "docs/hidden.txt",
      status: "M",
      add: 1,
      del: 0,
      binary: false,
      // Backend skip-worktree annotation — authoritative regardless of truncation.
      advanced: { kind: "sparse", message: "Outside sparse checkout" },
    };
    const changes: WorkingChanges = {
      staged: [],
      unstaged: [insideButUnsent, authoritativelyOutside],
      conflicted: [],
      advanced: {
        submodules: [],
        lfs: { detected: false, installed: null, issues: [], patterns: [] },
        sparseCheckout: { enabled: true, mode: "cone", patterns: ["/src/"], truncated: true },
      },
    };

    // Not blocked despite not matching the partial pattern list…
    expect(fileWriteGuard(insideButUnsent, changes)).toBeNull();
    // …while the authoritative backend annotation still blocks.
    expect(fileWriteGuard(authoritativelyOutside, changes)).toBe(
      "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.",
    );

    // The same partial list reported as complete *would* block it — proving the
    // truncated flag is what relaxes the guard.
    const completeChanges: WorkingChanges = {
      ...changes,
      advanced: {
        ...changes.advanced!,
        sparseCheckout: { enabled: true, mode: "cone", patterns: ["/src/"], truncated: false },
      },
    };
    expect(fileWriteGuard(insideButUnsent, completeChanges)).toBe(
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

  it("allows in-cone writes but blocks whole-tree discard in sparse checkout", () => {
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
    expect(discardAllGuardMessage(changes)).toBe(
      "Sparse checkout is enabled. Disable sparse checkout before using Discard all, or use the terminal.",
    );
  });

  it("blocks whole-tree discard before the first commit", () => {
    const changes: WorkingChanges = {
      staged: [{ path: "first.txt", status: "A", add: 1, del: 0, binary: false }],
      unstaged: [],
      conflicted: [],
      advanced: emptyAdvancedState,
    };

    expect(discardAllGuardMessage(changes, true)).toBe(
      "Discard all is unavailable before the first commit. Unstage or remove files individually, or use the terminal.",
    );
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
