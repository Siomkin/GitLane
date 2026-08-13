import { describe, expect, it } from "vitest";
import type { FileChange } from "@/lib/api";
import { PR_STATE } from "@/lib/prs";
import { AiActionScopeKind, type AiActionScope } from "./aiActions";
import {
  filesForScope,
  idleHint,
  matchingOpenPr,
  markClass,
  sameCommits,
  scopeCommitRows,
  scopeTally,
} from "./aiActionsView";

const file = (path: string, extra: Partial<FileChange> = {}): FileChange => ({
  path,
  status: "M",
  add: 1,
  del: 0,
  binary: false,
  ...extra,
});

describe("filesForScope", () => {
  const emptyChanges = { staged: [], unstaged: [], conflicted: [] };

  it("tallies nothing for a range, whose diff nothing here has loaded", () => {
    // `commits` carries only the head oid, so the single-commit rule below
    // would tally that one commit and undercount a span of many.
    const head = "headoid1";
    expect(
      filesForScope(
        { kind: AiActionScopeKind.Range, base: "baseoid0", head },
        {
          commitFiles: [file("only-the-head.ts")],
          selectionDiff: null,
          changes: emptyChanges,
          selectedCommit: head,
        },
      ),
    ).toEqual([]);
  });

  it("merges the working tree when that's the whole pick", () => {
    const files = filesForScope(
      { kind: AiActionScopeKind.Working },
      {
        commitFiles: [],
        selectionDiff: null,
        changes: {
          staged: [file("a.ts", { add: 2 })],
          unstaged: [file("a.ts", { add: 1, del: 1 }), file("b.ts", { status: "A", add: 4 })],
          conflicted: [],
        },
        selectedCommit: null,
      },
    );
    expect(files).toEqual([
      file("a.ts", { add: 3, del: 1 }),
      file("b.ts", { status: "A", add: 4 }),
    ]);
  });

  it("uses the loaded selection diff when the oids match", () => {
    const files = [file("sel.ts")];
    expect(
      filesForScope(
        { kind: AiActionScopeKind.Commits, commits: ["a", "b"] },
        {
          commitFiles: [file("commit.ts")],
          selectionDiff: { commits: ["b", "a"], files },
          changes: emptyChanges,
          selectedCommit: "a",
        },
      ),
    ).toBe(files);
  });

  it("falls back to the focused commit's files", () => {
    const commitFiles = [file("one.ts")];
    expect(
      filesForScope(
        { kind: AiActionScopeKind.Commits, commits: ["abc"] },
        {
          commitFiles,
          selectionDiff: null,
          changes: emptyChanges,
          selectedCommit: "abc",
        },
      ),
    ).toBe(commitFiles);
  });

  it("returns empty when the matching diff is not loaded", () => {
    expect(
      filesForScope(
        { kind: AiActionScopeKind.Commits, commits: ["abc"] },
        {
          commitFiles: [file("one.ts")],
          selectionDiff: null,
          changes: emptyChanges,
          selectedCommit: "other",
        },
      ),
    ).toEqual([]);
  });

  it("rejects a loaded union that is not this span's", () => {
    // `req` is a snapshot and the store moves on. Same commits but a different
    // base is a different span, so counting its files would put the range
    // defect back in the variant next door.
    const span: AiActionScope = { kind: AiActionScopeKind.Span, base: "base1", commits: ["abc"] };
    const ctx = {
      commitFiles: [file("head-only.ts")],
      changes: emptyChanges,
      selectedCommit: "abc",
    };
    expect(
      filesForScope(span, {
        ...ctx,
        selectionDiff: { commits: ["abc"], files: [file("union.ts")], workingBase: "base2" },
      }),
    ).toEqual([]);
    // No falling back to the single commit's files either — the prompt asks for
    // the working tree too.
    expect(filesForScope(span, { ...ctx, selectionDiff: null })).toEqual([]);
    expect(
      filesForScope(span, {
        ...ctx,
        selectionDiff: { commits: ["abc"], files: [file("union.ts")], workingBase: "base1" },
      }),
    ).toEqual([file("union.ts")]);
  });

  it("never tallies files a scope did not ask for", () => {
    // The defect this union exists to prevent: a scope whose sentence names
    // revisions the tally does not cover. With no union loaded, only the
    // commits-only variant may fall back to the focused commit's files — every
    // scope that also reads the working tree, or a range, must tally nothing.
    const commitFiles = [file("head-only.ts")];
    const ctx = {
      commitFiles,
      selectionDiff: null,
      changes: emptyChanges,
      selectedCommit: "abc",
    };
    const scopes: AiActionScope[] = [
      { kind: AiActionScopeKind.Working },
      { kind: AiActionScopeKind.Commits, commits: ["abc"] },
      { kind: AiActionScopeKind.CommitsWithWorking, commits: ["abc"] },
      { kind: AiActionScopeKind.Span, base: "base", commits: ["abc"] },
      { kind: AiActionScopeKind.Range, base: "base", head: "abc" },
    ];
    for (const scope of scopes) {
      const tallied = filesForScope(scope, ctx);
      if (scope.kind === AiActionScopeKind.Commits) expect(tallied).toBe(commitFiles);
      else expect(tallied).toEqual([]);
    }
  });
});

describe("sameCommits", () => {
  it("treats order as irrelevant", () => {
    expect(sameCommits(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameCommits(["a"], ["a", "b"])).toBe(false);
  });
});

describe("scopeTally / scopeCommitRows", () => {
  it("formats a tally only when there are files", () => {
    expect(scopeTally([])).toBeNull();
    expect(scopeTally([file("a.ts", { add: 4, del: 1 })])).toEqual({
      stats: "1 file",
      add: "+4",
      del: "−1",
    });
  });

  it("labels a commit by its summary, falling back to the oid", () => {
    expect(scopeCommitRows(["abc"], [{ id: "abc", summary: "Virtualize" }])).toEqual([
      { oid: "abc", summary: "Virtualize" },
    ]);
    expect(scopeCommitRows(["abc"], [])).toEqual([{ oid: "abc", summary: "abc" }]);
  });
});

describe("matchingOpenPr", () => {
  it("picks the open PR on the current branch", () => {
    const open = { num: 12, branch: "feat", state: PR_STATE.Open } as const;
    const closed = { num: 11, branch: "feat", state: PR_STATE.Closed } as const;
    expect(matchingOpenPr([closed, open] as never, "feat")).toMatchObject({ num: 12 });
    expect(matchingOpenPr([open] as never, "other")).toBeUndefined();
    expect(matchingOpenPr([open] as never, null)).toBeUndefined();
  });
});

describe("idleHint", () => {
  it("tells the agent to read the repo, not that GitLane ships a diff", () => {
    const hint = idleHint({
      req: { kind: AiActionScopeKind.Commits, commits: ["abcdef0"] },
      tally: { stats: "1 file", add: "+4", del: "−1" },
      agentName: "Claude Code",
    });
    expect(hint).toContain("Claude Code will read");
    expect(hint).toContain("in the repo");
    expect(hint).not.toContain("will send");
  });

  it("names the scope once when there is no tally to show", () => {
    const hint = idleHint({
      req: { kind: AiActionScopeKind.Range, base: "baseoid0", head: "headoid1" },
      tally: null,
      agentName: "Claude Code",
    });
    expect(hint).toBe(
      "Claude Code will read range baseoid..headoid in the repo and stream the result here.",
    );
  });
});

describe("markClass", () => {
  it("colours added / deleted / other", () => {
    expect(markClass("A")).toContain("emerald");
    expect(markClass("D")).toContain("rose");
    expect(markClass("M")).toContain("amber");
  });
});
