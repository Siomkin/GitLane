import { describe, expect, it } from "vitest";
import { DEFAULT_COMMIT_AGENT_MESSAGES } from "@/store/commitAgentMessages";
import {
  AiActionId,
  AiActionScopeKind,
  buildAiActionPrompt,
  extraPlaceholder,
  formatTally,
  instructionFor,
  jiraKeyFrom,
  mergeFileRows,
  pickerActions,
  resolveAction,
  scopeFromSelection,
  scopeFromStackedReview,
  scopeLabel,
  scopeSentence,
  tallyChanges,
  type AiActionScope,
} from "./aiActions";

const commands = DEFAULT_COMMIT_AGENT_MESSAGES.aiActions;

/** One scope per variant, so every consumer's switch can be walked exhaustively
 *  in a table rather than each test inventing its own literal. */
const SCOPES = {
  [AiActionScopeKind.Working]: { kind: AiActionScopeKind.Working },
  [AiActionScopeKind.Commits]: { kind: AiActionScopeKind.Commits, commits: ["abcdef0"] },
  [AiActionScopeKind.CommitsWithWorking]: {
    kind: AiActionScopeKind.CommitsWithWorking,
    commits: ["abcdef0", "def"],
  },
  [AiActionScopeKind.Span]: {
    kind: AiActionScopeKind.Span,
    base: "baseoid",
    commits: ["abcdef0", "def"],
  },
  [AiActionScopeKind.Range]: {
    kind: AiActionScopeKind.Range,
    base: "baseoid0",
    head: "headoid1",
  },
} as const satisfies Record<AiActionScopeKind, AiActionScope>;

describe("scopeLabel", () => {
  it("names a single commit, a multi pick, WIP, the mix, and a range", () => {
    expect(scopeLabel(SCOPES.commits)).toBe("Commit abcdef0");
    expect(
      scopeLabel({ kind: AiActionScopeKind.Commits, commits: ["a", "b", "c"] }),
    ).toBe("3 commits");
    expect(scopeLabel(SCOPES.working)).toBe("Uncommitted changes");
    expect(
      scopeLabel({ kind: AiActionScopeKind.CommitsWithWorking, commits: ["abcdef0"] }),
    ).toBe("Commit abcdef0 + uncommitted");
    expect(scopeLabel(SCOPES.span)).toBe("2 commits + uncommitted");
    expect(scopeLabel(SCOPES.range)).toBe("Range baseoid..headoid");
  });

  it("labels every variant", () => {
    // The union is the whole point: a new variant fails here (and in the
    // switch) instead of silently falling through to someone's default.
    for (const scope of Object.values(SCOPES)) {
      expect(scopeLabel(scope)).not.toBe("");
    }
  });
});

describe("scopeSentence", () => {
  it("points the agent at git show / the working tree, not a shipped diff", () => {
    expect(scopeSentence({ kind: AiActionScopeKind.Commits, commits: ["abc"] })).toContain(
      "git show abc",
    );
    expect(scopeSentence(SCOPES.working)).toContain("git diff HEAD");
    expect(scopeSentence(SCOPES.commitsWithWorking)).toContain("together with");
    expect(scopeSentence(SCOPES.range)).toContain("git diff baseoid0 headoid1");
  });

  it("asks for one merged diff when commits were picked with the WIP row", () => {
    // The rest of the app reviews this pick as base → working tree; the agent
    // has to read the same span, not `git show` plus a separate `git diff HEAD`.
    const sentence = scopeSentence(SCOPES.span);
    expect(sentence).toContain("git diff baseoid");
    expect(sentence).not.toContain("git show");
    expect(sentence).not.toContain("git diff HEAD");
  });

  it("names revisions for every variant", () => {
    for (const scope of Object.values(SCOPES)) {
      expect(scopeSentence(scope)).toMatch(/^Read /);
    }
  });
});

describe("scopeFromSelection", () => {
  it("returns null when nothing is selected", () => {
    expect(
      scopeFromSelection({ selectedCommits: [], selectedCommit: null, wipSelected: false }),
    ).toBeNull();
  });

  it("prefers the multi-commit set over the focus oid", () => {
    expect(
      scopeFromSelection({
        selectedCommits: ["c1", "c2"],
        selectedCommit: "c1",
        wipSelected: false,
      }),
    ).toEqual({ kind: AiActionScopeKind.Commits, commits: ["c1", "c2"] });
  });

  it("scopes one commit passed without a focus oid to that commit", () => {
    // The commit context menu passes the clicked commit as the whole pick with
    // no focus oid; routing it by `selectedCommit` alone would fall through to
    // the working tree and run the action against the wrong changes.
    expect(
      scopeFromSelection({ selectedCommits: ["c1"], selectedCommit: null, wipSelected: false }),
    ).toEqual({ kind: AiActionScopeKind.Commits, commits: ["c1"] });
  });

  it("is the WIP row alone when only it is picked", () => {
    expect(
      scopeFromSelection({ selectedCommits: [], selectedCommit: null, wipSelected: true }),
    ).toEqual({ kind: AiActionScopeKind.Working });
  });

  it("folds the WIP row into a commit pick as one span", () => {
    expect(
      scopeFromSelection({
        selectedCommits: ["c1"],
        selectedCommit: "c1",
        wipSelected: true,
        workingBase: "base1",
      }),
    ).toEqual({ kind: AiActionScopeKind.Span, base: "base1", commits: ["c1"] });
  });

  it("treats WIP in the pick with no base as the working tree", () => {
    // Same shape as a plain WIP selection after a refresh republishes the tip:
    // no workingBase, so the route is `working`, not a commit or a two-read
    // fallback. The store does not produce this combination for a failed span.
    expect(
      scopeFromSelection({
        selectedCommits: ["c1"],
        selectedCommit: "c1",
        wipSelected: true,
        workingBase: null,
      }),
    ).toEqual({ kind: AiActionScopeKind.Working });
  });

  it("drops the merged base when the WIP row is not in the pick", () => {
    // Without WIP there is no span ending at the working tree, so a stale
    // workingBase must not make the prompt ask for one.
    expect(
      scopeFromSelection({
        selectedCommits: ["c1"],
        selectedCommit: "c1",
        wipSelected: false,
        workingBase: "base1",
      }),
    ).toEqual({ kind: AiActionScopeKind.Commits, commits: ["c1"] });
  });
});

describe("scopeFromStackedReview", () => {
  it("maps a commit, a range, and a multi-commit selection", () => {
    expect(scopeFromStackedReview({ oid: "c1" })).toEqual({
      kind: AiActionScopeKind.Commits,
      commits: ["c1"],
    });
    expect(scopeFromStackedReview({ oid: "head", range: { base: "base", head: "head" } })).toEqual({
      kind: AiActionScopeKind.Range,
      base: "base",
      head: "head",
    });
    expect(scopeFromStackedReview({ oid: "c1", selection: ["c1", "c2"] })).toEqual({
      kind: AiActionScopeKind.Commits,
      commits: ["c1", "c2"],
    });
  });
});

describe("picker / resolve", () => {
  it("lists enabled commands then Custom, and hides disabled ones", () => {
    const ids = pickerActions(commands).map((row) => row.id);
    expect(ids).toEqual(["short", "full", "impl", "release", "review", "test", "custom"]);
    const disabledShort = commands.map((command) =>
      command.id === "short" ? { ...command, enabled: false } : command,
    );
    expect(pickerActions(disabledShort).map((row) => row.id)).toEqual([
      "full",
      "impl",
      "release",
      "review",
      "test",
      "custom",
    ]);
  });

  it("prefers impl when nothing is requested, and falls back when short is off", () => {
    expect(resolveAction(undefined, commands)).toBe("impl");
    expect(resolveAction("short", commands)).toBe("short");
    const disabledShort = commands.map((command) =>
      command.id === "short" ? { ...command, enabled: false } : command,
    );
    expect(resolveAction("short", disabledShort)).toBe("full");
    expect(resolveAction(undefined, disabledShort)).toBe("impl");
  });
});

describe("buildAiActionPrompt", () => {
  it("keeps the agent on the diff and names the ticket key when the branch has one", () => {
    const impl = buildAiActionPrompt({
      scope: { kind: AiActionScopeKind.Commits, commits: ["abc"] },
      action: AiActionId.Impl,
      extra: "keep it short",
      jiraKey: "GL-12",
      instruction: instructionFor(AiActionId.Impl, commands),
    });
    expect(impl).toContain("do not open unrelated files");
    expect(impl).toContain("GL-12");
    expect(impl).toContain("implementation update");
    expect(impl).toContain("developers, product, and QA");
    expect(impl).not.toContain("Jira");
    expect(impl).toContain("Also: keep it short");

    const short = buildAiActionPrompt({
      scope: { kind: AiActionScopeKind.Commits, commits: ["abc"] },
      action: AiActionId.Short,
      extra: "",
      jiraKey: "GL-12",
      instruction: instructionFor(AiActionId.Short, commands),
    });
    expect(short).toContain("GL-12");
  });

  it("uses the custom notes as the whole instruction", () => {
    const prompt = buildAiActionPrompt({
      scope: { kind: AiActionScopeKind.Working },
      action: AiActionId.Custom,
      extra: "List the riskiest files.",
      instruction: instructionFor(AiActionId.Custom, commands),
    });
    expect(prompt).toContain("List the riskiest files.");
    expect(prompt).not.toContain("Also:");
    expect(prompt).toContain("Reply with the final result and nothing else");
    expect(prompt).toContain("skill");
    expect(prompt).not.toContain("do not open unrelated files");
  });
});

describe("jiraKeyFrom", () => {
  it("pulls a ticket key out of a branch name", () => {
    expect(jiraKeyFrom("feature/GL-142-thing")).toBe("GL-142");
    expect(jiraKeyFrom("main")).toBeNull();
  });
});

describe("tally / merge", () => {
  it("counts files and sums line stats", () => {
    expect(tallyChanges([{ add: 10, del: 2 }, { add: 1, del: 4 }])).toEqual({
      count: 2,
      add: 11,
      del: 6,
    });
    expect(formatTally({ count: 1, add: 3, del: 1 })).toEqual({
      stats: "1 file",
      add: "+3",
      del: "−1",
    });
  });

  it("dedupes paths and sums staged + unstaged counts", () => {
    const rows = mergeFileRows([
      [{ path: "a.ts", add: 2, del: 0, status: "M" }],
      [{ path: "a.ts", add: 1, del: 3, status: "M" }, { path: "b.ts", add: 4, del: 0, status: "A" }],
    ]);
    expect(rows).toEqual([
      { path: "a.ts", add: 3, del: 3, status: "M" },
      { path: "b.ts", add: 4, del: 0, status: "A" },
    ]);
  });
});

describe("extraPlaceholder", () => {
  it("asks for the whole prompt on Custom", () => {
    expect(extraPlaceholder(AiActionId.Custom, "Custom prompt")).toMatch(/Describe what you want/);
    expect(extraPlaceholder(AiActionId.Short, "Short description")).toMatch(/short description/);
  });
});
