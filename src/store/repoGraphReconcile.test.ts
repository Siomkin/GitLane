import { describe, expect, it } from "vitest";
import type { CommitNode, RepoGraph } from "@/lib/api";
import type { LiveRefreshSelection, RefreshSelectionOwner } from "./repoGraphReconcile";
import { reconcileGraphSelection } from "./repoGraphReconcile";

const commit = (id: string, stash = false): CommitNode => ({
  id,
  shortId: id,
  summary: id,
  body: "",
  authorName: "Alex",
  authorEmail: "alex@example.dev",
  timestamp: 1,
  parents: [],
  lane: 0,
  row: 0,
  color: 0,
  refs: [],
  ...(stash ? { stash: { index: 0, message: "stash" } } : {}),
});

const graph = (...commits: CommitNode[]): RepoGraph => ({
  commits,
  edges: [],
  laneCount: 1,
  head: commits.find((node) => !node.stash)?.id ?? null,
  truncated: false,
});

const owner = (
  selectedCommits: string[],
  overrides: Partial<RefreshSelectionOwner> = {},
): RefreshSelectionOwner => ({
  requestId: 4,
  selectedCommit: selectedCommits[0] ?? null,
  selectedCommits,
  ...overrides,
});

const live = (
  selectedCommits: string[],
  overrides: Partial<LiveRefreshSelection> = {},
): LiveRefreshSelection => ({
  requestId: 4,
  selectedCommit: selectedCommits[0] ?? null,
  selectedCommits,
  selectionAnchor: selectedCommits[0] ?? null,
  selectionDiff: null,
  selectedFile: null,
  ...overrides,
});

describe("reconcileGraphSelection", () => {
  it("falls back to the first real commit and invalidates commit-file ownership", () => {
    const selected = ["removed"];
    const result = reconcileGraphSelection({
      graph: graph(commit("stash", true), commit("tip")),
      selectionOwner: owner(selected),
      liveSelection: live(selected, {
        requestId: 7,
        selectionAnchor: "removed",
        selectedFile: { path: "old.ts", source: "commit" },
      }),
      repoSessionCurrent: true,
    });

    expect(result.publishSelection).toBe(true);
    expect(result.selectionCommitToLoad).toBe("tip");
    expect(result.publishedSelectionRequestId).toBe(8);
    expect(result.patch).toMatchObject({
      fileSelectionRequestId: 8,
      commitFiles: [],
      diffLoading: true,
      selectedFile: null,
      fileDiff: null,
      selectedCommit: "tip",
      selectedCommits: ["tip"],
      selectionAnchor: "tip",
      selectionDiff: null,
    });
  });

  it("clears focus, selection, anchor, and union for a truly empty graph", () => {
    const selected = ["removed-a", "removed-b"];
    const result = reconcileGraphSelection({
      graph: graph(),
      selectionOwner: owner(selected),
      liveSelection: live(selected, {
        requestId: 9,
        selectionAnchor: "removed-b",
        selectionDiff: {
          commits: selected,
          files: [{ path: "stale.ts", status: "M", add: 1, del: 0, binary: false }],
          loading: false,
          error: null,
        },
      }),
      repoSessionCurrent: true,
    });

    expect(result.selectionCommitToLoad).toBeNull();
    expect(result.multiNow).toBe(false);
    expect(result.patch).toMatchObject({
      fileSelectionRequestId: 10,
      commitFiles: [],
      diffLoading: false,
      selectedCommit: null,
      selectedCommits: [],
      selectionAnchor: null,
      selectionDiff: null,
    });
  });

  it("falls back to null rather than selecting a stash-only graph node", () => {
    const selected = ["removed"];
    const result = reconcileGraphSelection({
      graph: graph(commit("stash", true)),
      selectionOwner: owner(selected),
      liveSelection: live(selected),
      repoSessionCurrent: true,
    });

    expect(result.selectionCommitToLoad).toBeNull();
    expect(result.patch.selectedCommit).toBeNull();
    expect(result.patch.selectedCommits).toEqual([]);
    expect(result.patch.selectionAnchor).toBeNull();
    expect(result.patch.selectionDiff).toBeNull();
    expect(result.patch.diffLoading).toBe(false);
  });

  it("preserves selectedCommits identity and a healthy union for an unchanged set", () => {
    const selected = ["b", "a"];
    const cachedFiles = [{ path: "both.ts", status: "M" as const, add: 1, del: 1, binary: false }];
    const cached = { commits: ["a", "b"], files: cachedFiles, loading: false, error: null };
    const result = reconcileGraphSelection({
      graph: graph(commit("a"), commit("b")),
      selectionOwner: owner(selected, { selectedCommit: "a" }),
      liveSelection: live(selected, {
        selectedCommit: "a",
        selectionAnchor: "b",
        selectionDiff: cached,
      }),
      repoSessionCurrent: true,
    });

    expect(result.selectedCommits).toBe(selected);
    expect(result.patch.selectedCommits).toBe(selected);
    expect(result.reuseUnion).toBe(true);
    expect(result.patch.selectionDiff).not.toBe(cached);
    expect(result.patch.selectionDiff?.commits).toBe(selected);
    expect(result.patch.selectionDiff?.files).toBe(cachedFiles);
    expect(result.patch).not.toHaveProperty("fileSelectionRequestId");
  });

  it("trims removed commits and requests a fresh union for the surviving multi-selection", () => {
    const selected = ["a", "b", "removed"];
    const result = reconcileGraphSelection({
      graph: graph(commit("a"), commit("b")),
      selectionOwner: owner(selected),
      liveSelection: live(selected, {
        selectionDiff: {
          commits: selected,
          files: [{ path: "stale.ts", status: "M", add: 1, del: 0, binary: false }],
          loading: false,
          error: null,
        },
      }),
      repoSessionCurrent: true,
    });

    expect(result.selectedCommits).toEqual(["a", "b"]);
    expect(result.selectedCommits).not.toBe(selected);
    expect(result.multiNow).toBe(true);
    expect(result.reuseUnion).toBe(false);
    expect(result.patch.selectionDiff).toEqual({
      commits: ["a", "b"],
      files: [],
      loading: true,
      error: null,
    });
    expect(result.patch.fileSelectionRequestId).toBe(5);
  });

  it("retries an errored union without inventing a selection change", () => {
    const selected = ["a", "b"];
    const result = reconcileGraphSelection({
      graph: graph(commit("a"), commit("b")),
      selectionOwner: owner(selected),
      liveSelection: live(selected, {
        selectionDiff: { commits: selected, files: [], loading: false, error: "boom" },
      }),
      repoSessionCurrent: true,
    });

    expect(result.selectedCommits).toBe(selected);
    expect(result.reuseUnion).toBe(false);
    expect(result.patch.selectionDiff).toEqual({
      commits: selected,
      files: [],
      loading: true,
      error: null,
    });
    expect(result.patch).not.toHaveProperty("fileSelectionRequestId");
  });

  it("preserves a newer valid foreground selection, including same-value new arrays", () => {
    const captured = ["a", "b"];
    const newer = ["a", "b"];
    const result = reconcileGraphSelection({
      graph: graph(commit("a"), commit("b")),
      selectionOwner: owner(captured),
      liveSelection: live(newer),
      repoSessionCurrent: true,
    });

    expect(newer).not.toBe(captured);
    expect(result.publishSelection).toBe(false);
    expect(result.patch).toEqual({});
  });

  it("does not publish into a replaced repo session even when selection references match", () => {
    const selected = ["a"];
    const result = reconcileGraphSelection({
      graph: graph(commit("a")),
      selectionOwner: owner(selected),
      liveSelection: live(selected),
      repoSessionCurrent: false,
    });

    expect(result.publishSelection).toBe(false);
    expect(result.patch).toEqual({});
  });

  it("reconciles a newer selection when its focus no longer exists", () => {
    const captured = ["old"];
    const newer = ["removed"];
    const result = reconcileGraphSelection({
      graph: graph(commit("tip")),
      selectionOwner: owner(captured),
      liveSelection: live(newer),
      repoSessionCurrent: true,
    });

    expect(result.publishSelection).toBe(true);
    expect(result.patch.selectedCommit).toBe("tip");
    expect(result.patch.selectedCommits).toEqual(["tip"]);
  });
});
