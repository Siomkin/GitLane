// A dirty editor draft is dropped only after the user confirms: every way out
// asks first, declining keeps the draft, and a clean editor is never in the way.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyIpcInvoke } from "@/test/ipcFixtures";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";
import type { FileViewState, RepoState } from "@/store/repoTypes";
import { useUi } from "@/store/ui";
import { summary } from "@/test/repoFixtures";
import {
  closeRepoGuarded,
  loadRepoGuarded,
  openCompareGuarded,
  openFileHistoryGuarded,
  returnToGraphGuarded,
  revealCommitGuarded,
  revealStashGuarded,
  selectCommitMultiGuarded,
  selectFileGuarded,
  selectWipGuarded,
} from "./guardedExits";

const draftFile = (draft: string, saving = false) =>
  ({
    path: "a.ts",
    content: { text: "saved" },
    loading: false,
    error: null,
    edit: { draft, baseSize: 5, baseExpectedState: "s", saving },
  }) as unknown as FileViewState;
const DIRTY = draftFile("typed");
const CLEAN = draftFile("saved");

const real = useRepo.getState();
const compareRequest = { base: "a", head: "b", baseLabel: "a", headLabel: "b", scope: "commit" as const, title: "t" };

const confirmDialog = () => useUi.getState().confirm;
const confirmDiscard = () => {
  const dialog = confirmDialog();
  useUi.setState({ confirm: null });
  dialog?.onConfirm();
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  useRepo.setState(real, true);
  useRepo.setState({ summary, openPaths: [summary.path], fileView: null, selectedFile: null });
  useUi.setState({ confirm: null });
});

afterEach(() => useRepo.setState(real, true));

describe.each<[keyof RepoState, () => Promise<void>, unknown[]]>([
  ["selectFile", () => selectFileGuarded("a.ts", "unstaged"), ["a.ts", "unstaged"]],
  ["selectCommitMulti", () => selectCommitMultiGuarded("c1", {}), ["c1", {}]],
  ["selectWip", () => selectWipGuarded(), []],
  ["returnToGraph", () => returnToGraphGuarded(), []],
  ["revealCommit", () => revealCommitGuarded("c1"), ["c1"]],
  ["revealStash", () => revealStashGuarded("s1"), ["s1"]],
  ["openCompare", () => openCompareGuarded(compareRequest), [compareRequest]],
  ["openFileHistory", () => openFileHistoryGuarded("a.ts", "blame"), ["a.ts", "blame"]],
  ["loadRepo", () => loadRepoGuarded("/other"), ["/other"]],
  ["closeRepo", () => closeRepoGuarded(summary.path), [summary.path]],
])("%s", (action, exit, args) => {
  const spy = vi.fn();
  beforeEach(() => {
    spy.mockReset();
    useRepo.setState({ [action]: spy });
  });

  it("asks before leaving a dirty draft, and leaves on confirm", () => {
    useRepo.setState({ fileView: DIRTY });
    void exit();
    expect(confirmDialog()?.title).toBe("Discard unsaved changes?");
    expect(spy).not.toHaveBeenCalled();
    confirmDiscard();
    expect(spy).toHaveBeenCalledWith(...args);
  });

  it("keeps the draft when the user declines", () => {
    useRepo.setState({ fileView: DIRTY });
    void exit();
    useUi.setState({ confirm: null });
    expect(spy).not.toHaveBeenCalled();
    expect(useRepo.getState().fileView).toBe(DIRTY);
  });

  it("does not ask for a clean editor", () => {
    useRepo.setState({ fileView: CLEAN });
    void exit();
    expect(confirmDialog()).toBeNull();
    expect(spy).toHaveBeenCalledWith(...args);
  });
});

describe("guardDirtyFileView", () => {
  it("returns the result of a clean exit, synchronously", () => {
    expect(useRepo.getState().guardDirtyFileView(() => "ran")).toBe("ran");
  });

  it("ignores an exit while a save is committing", () => {
    useRepo.setState({ fileView: draftFile("typed", true) });
    const run = vi.fn();
    const showToast = vi.fn();
    const realShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });
    useRepo.getState().guardDirtyFileView(run);
    useUi.setState({ showToast: realShowToast });
    expect(confirmDialog()).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("drops the exit if a save started while the dialog was up", () => {
    useRepo.setState({ fileView: DIRTY });
    const run = vi.fn();
    useRepo.getState().guardDirtyFileView(run);
    useRepo.setState({ fileView: draftFile("typed", true) });
    confirmDiscard();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("a tab still opening", () => {
  it("stands down when the user types in the editor on screen", () => {
    useRepo.setState({ fileView: CLEAN, pendingOpen: { path: "/other", tab: "/other" } });
    useRepo.getState().updateFileDraft("typed");
    expect(useRepo.getState().pendingOpen).toBeNull();
  });
});

describe("closing a tab", () => {
  it("does not ask for a background tab, and the draft stays", async () => {
    const closeRepo = vi.fn(async () => {});
    useRepo.setState({ closeRepo, fileView: DIRTY });
    await closeRepoGuarded("/background");
    expect(confirmDialog()).toBeNull();
    expect(closeRepo).toHaveBeenCalledWith("/background");
    expect(useRepo.getState().fileView).toBe(DIRTY);
  });
});

describe("worktree landings", () => {
  const loadRepo = vi.fn(async () => {});
  beforeEach(() => {
    loadRepo.mockClear();
    useRepo.setState({ loadRepo });
  });

  it("openWorktree asks first, then switches with the draft dropped", async () => {
    useRepo.setState({ fileView: DIRTY });
    await useRepo.getState().openWorktree("/wt");
    expect(confirmDialog()).not.toBeNull();
    expect(loadRepo).not.toHaveBeenCalled();
    confirmDiscard();
    expect(loadRepo).toHaveBeenCalledWith("/wt", { replaceTab: summary.path });
    expect(confirmDialog()).toBeNull();
  });

  it("openWorktree keeps the draft when declined", async () => {
    useRepo.setState({ fileView: DIRTY });
    await useRepo.getState().openWorktree("/wt");
    useUi.setState({ confirm: null });
    expect(loadRepo).not.toHaveBeenCalled();
    expect(useRepo.getState().fileView).toBe(DIRTY);
  });

  it("openWorktree starts the load synchronously when clean", () => {
    void useRepo.getState().openWorktree("/wt");
    expect(loadRepo).toHaveBeenCalledTimes(1);
    expect(confirmDialog()).toBeNull();
  });

  it("createWorktreeAt adds the worktree but asks before landing on it", async () => {
    useRepo.setState({ fileView: DIRTY });
    await useRepo.getState().createWorktreeAt("/wt", "main");
    expect(loadRepo).not.toHaveBeenCalled();
    expect(confirmDialog()).not.toBeNull();
    confirmDiscard();
    expect(loadRepo).toHaveBeenCalledTimes(1);
  });

  it("moveBranchToWorktree moves the branch but asks before landing", async () => {
    useRepo.setState({ fileView: DIRTY });
    await useRepo.getState().moveBranchToWorktree("feat", summary.path, "/wt", false);
    expect(loadRepo).not.toHaveBeenCalled();
    expect(confirmDialog()).not.toBeNull();
    confirmDiscard();
    expect(loadRepo).toHaveBeenCalledTimes(1);
  });

  describe("a checkout landing in another worktree", () => {
    // Prunable: the plain open, without the "check out here?" hand-off dialog.
    const worktrees = [
      { path: "/wt", branch: "feat", prunable: true },
    ] as unknown as RepoState["worktrees"];
    beforeEach(() => useRepo.setState({ worktrees, fileView: DIRTY }));

    it("does not claim it opened while the discard dialog is up", async () => {
      expect(await useRepo.getState().checkoutBranch("feat")).toBe("");
      expect(confirmDialog()?.title).toBe("Discard unsaved changes?");
      expect(loadRepo).not.toHaveBeenCalled();
    });

    it("reports only the branch update for a remote branch", async () => {
      expect(await useRepo.getState().checkoutRemoteBranch("origin", "feat")).toBe("Updated feat");
      expect(loadRepo).not.toHaveBeenCalled();
    });
  });
});

describe("reconciling the selection leaves an open editor alone", () => {
  const changes = {
    staged: [{ path: "a.ts", status: "M" }],
    unstaged: [{ path: "b.ts", status: "M" }],
    conflicted: [],
  } as unknown as RepoState["changes"];
  const refresh = vi.fn(async () => true);
  beforeEach(() => {
    refresh.mockClear();
    useRepo.setState({ changes, refresh, fileView: DIRTY });
  });

  const expectEditorKept = () => {
    expect(useRepo.getState().fileView).toBe(DIRTY);
    expect(confirmDialog()).toBeNull();
  };

  it("ensureWorkingFileSelection (the Details panel opening)", () => {
    useRepo.getState().ensureWorkingFileSelection();
    expect(useRepo.getState().selectedFile).toEqual({ path: "b.ts", source: "unstaged" });
    expectEditorKept();
  });

  it("ensureWorkingFileSelection moving a file between buckets", () => {
    useRepo.setState({ selectedFile: { path: "a.ts", source: "unstaged" } });
    useRepo.getState().ensureWorkingFileSelection();
    expect(useRepo.getState().selectedFile).toEqual({ path: "a.ts", source: "staged" });
    expectEditorKept();
  });

  it("stageFile", async () => {
    await useRepo.getState().stageFile("b.ts");
    expect(useRepo.getState().selectedFile).toEqual({ path: "b.ts", source: "staged" });
    expectEditorKept();
  });

  it("unstageFile", async () => {
    await useRepo.getState().unstageFile("a.ts");
    expect(useRepo.getState().selectedFile).toEqual({ path: "a.ts", source: "unstaged" });
    expectEditorKept();
  });

  it("a hunk patch reselecting its file", async () => {
    await useRepo.getState().applyHunk("a.ts", true, 0, "@@", "+x");
    expect(useRepo.getState().selectedFile).toEqual({ path: "a.ts", source: "staged" });
    expectEditorKept();
  });

  it("a discard re-pointing the selection", async () => {
    useRepo.setState({ selectedFile: { path: "a.ts", source: "unstaged" } });
    await useRepo.getState().discardFile(summary.path, "a.ts", null, false, "state");
    expect(useRepo.getState().selectedFile).toEqual({ path: "a.ts", source: "staged" });
    expectEditorKept();
  });

  it("selectFile on its own still closes the viewer", async () => {
    await useRepo.getState().selectFile("b.ts", "unstaged");
    expect(useRepo.getState().fileView).toBeNull();
  });
});

describe("programmatic wipes", () => {
  it("are not guarded: nobody is there to answer", async () => {
    useRepo.setState({ fileView: DIRTY });
    await useRepo.getState().closeRepo(summary.path);
    expect(confirmDialog()).toBeNull();
    expect(useRepo.getState().fileView).toBeNull();
  });
});

// The wrappers above are only as good as their adoption: UI code that reaches for
// the raw action would drop a draft silently, with no test of its own to fail.
describe("UI call sites", () => {
  const EXITS = new Set([
    "selectFile",
    "selectCommit",
    "selectCommitMulti",
    "selectWip",
    "returnToGraph",
    "revealCommit",
    "revealStash",
    "openCompare",
    "openFileHistory",
    "loadRepo",
    "closeRepo",
  ]);
  // Each of these runs the raw action inside its own guard (or has no editor).
  const ALLOWED: Record<string, string[]> = {
    "../features/changes/WorkingInspector.tsx": ["selectFile"],
    "../components/chrome/TitleBar.tsx": ["returnToGraph"],
    "../features/onboarding/flows/useOnboarding.ts": ["loadRepo"],
    "../features/missing-repo/MissingRepoScreen.tsx": ["loadRepo", "closeRepo"],
  };

  /** The exit actions a source reaches by member access or by destructuring. */
  const rawExits = (source: string) => {
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    const accessed = [...code.matchAll(/\.(\w+)\b/g)].map((match) => match[1]);
    const destructured = [
      ...code.matchAll(/\{([^{}]*)\}\s*=\s*(?:useRepo\.getState\(\)|state\b)/g),
    ].flatMap((match) => match[1].split(",").map((name) => name.split(":")[0].trim()));
    return [...accessed, ...destructured].filter((name) => EXITS.has(name));
  };

  const SOURCES = import.meta.glob<string>(
    [
      "../features/**/*.{ts,tsx}",
      "../components/**/*.{ts,tsx}",
      "../app-shell/**/*.{ts,tsx}",
      "../hooks/**/*.{ts,tsx}",
      "!../**/*.test.{ts,tsx}",
    ],
    { query: "?raw", import: "default", eager: true },
  );

  it("go through the guarded exits", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    const offenders = Object.entries(SOURCES).flatMap(([file, source]) =>
      rawExits(source)
        .filter((name) => !ALLOWED[file]?.includes(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it("detect every way of reaching a raw action", () => {
    expect(rawExits("useRepo((s) => s.selectCommit)")).toEqual(["selectCommit"]);
    expect(rawExits("const { loadRepo, summary } = useRepo.getState();")).toEqual(["loadRepo"]);
    expect(rawExits("const { openCompare: open } = state;")).toEqual(["openCompare"]);
    expect(rawExits("// s.selectFile in a comment")).toEqual([]);
  });

  it("leave store code reselecting without closing the editor", () => {
    const STORE = import.meta.glob<string>(["./**/*.ts", "!./**/*.test.ts"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const offenders = Object.entries(STORE)
      .filter(([, source]) => /get\(\)\.selectFile\b/.test(source))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
