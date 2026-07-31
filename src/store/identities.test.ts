import { beforeEach, describe, expect, it, vi } from "vitest";

// Simulated repo-local git config so apply/clear/read round-trip like the real
// backend.
const state = vi.hoisted(() => ({
  cfg: new Map<string, { name: string; email: string }>(),
}));
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "@/lib/api";
import type { GitProfile } from "@/lib/profiles";
import type { CommitSourceRef } from "@/lib/identities";
import { useRepo } from "./repo";
import { useAccounts } from "./accounts";
import { appliedCommitSource, useIdentities } from "./identities";
import { useUi } from "./ui";

const path = "repo-under-test";
const summary: RepoSummary = {
  path,
  workdir: path,
  headBranch: "main",
  headOid: "abc",
  detached: false,
};
const otherPath = "other-repo";
const otherSummary: RepoSummary = {
  path: otherPath,
  workdir: otherPath,
  headBranch: "main",
  headOid: "def",
  detached: false,
};

const personal: GitProfile = {
  id: "p1",
  label: "Personal",
  name: "Stepan Personal",
  email: "personal@example.dev",
  color: "#5b8def",
  isDefault: true,
};
const work: GitProfile = {
  id: "p2",
  label: "Work",
  name: "Stepan Work",
  email: "work@acme.io",
  color: "#2f9e7e",
};

const manualRef = (id: string): CommitSourceRef => ({ kind: "manual", id });

beforeEach(() => {
  state.cfg.clear();
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    const p = args?.path as string;
    switch (cmd) {
      case "set_repo_identity":
        state.cfg.set(p, { name: args.name as string, email: args.email as string });
        return "ok";
      case "repo_identity":
        return state.cfg.get(p) ?? null;
      case "clear_repo_identity":
        state.cfg.delete(p);
        return "ok";
      default:
        return null;
    }
  });
  useRepo.setState({ summary });
  useAccounts.setState({ repoIdentity: null, repoBindingKey: null });
  useIdentities.setState({
    manualIdentities: [personal, work],
    defaultIdentity: null,
  });
});

describe("useIdentities — storage migration and keying", () => {
  it("moves legacy identity cards to the versioned key", () => {
    localStorage.setItem("gitlane.profiles", JSON.stringify([personal]));

    useIdentities.getState().loadIdentities();

    expect(localStorage.getItem("gitlane.profiles")).toBeNull();
    expect(JSON.parse(localStorage.getItem("gitlane.profiles:v1")!)).toEqual([personal]);
  });

  it("keeps valid identity cards when neighboring persisted rows are malformed", () => {
    localStorage.setItem(
      "gitlane.profiles:v1",
      JSON.stringify([
        personal,
        null,
        { ...work, email: 42 },
        { ...work, id: "p3", gpgFormat: "unsupported" },
        { ...work, id: "blank-label", label: "   " },
        { ...work, id: "blank-name", name: "\t" },
        { ...work, id: "invalid-email", email: "work@localhost" },
        {
          ...work,
          id: "p4",
          label: "  Valid Work  ",
          name: "  Stepan Work  ",
          email: "  work@acme.io  ",
        },
      ]),
    );

    expect(() => useIdentities.getState().loadIdentities()).not.toThrow();
    expect(useIdentities.getState().manualIdentities.map((card) => card.id)).toEqual(["p1", "p4"]);
    expect(useIdentities.getState().manualIdentities[1]).toMatchObject({
      label: "Valid Work",
      name: "Stepan Work",
      email: "work@acme.io",
    });
  });

  it("drops malformed applied-card references instead of trusting their shape", () => {
    localStorage.setItem(
      "gitlane.repoCommitSource",
      JSON.stringify({ [path]: null, "/valid": { kind: "manual", id: "p2" } }),
    );

    expect(appliedCommitSource()).toBeNull();
    expect(() => useIdentities.getState().deleteManualIdentity("p2")).not.toThrow();
  });

  it("migrates the applied profile key once and deletes removed custom-email keys", () => {
    localStorage.setItem("gitlane.repoProfile", JSON.stringify({ [path]: "p2" }));
    localStorage.setItem(
      "gitlane.repoProfileEmail",
      JSON.stringify({ [path]: { p2: "old@custom.dev" } }),
    );
    localStorage.setItem(
      "gitlane.repoCommitEmail",
      JSON.stringify({ [path]: { "manual:p2": "stale@custom.dev" } }),
    );

    useIdentities.getState().loadIdentities();

    expect(JSON.parse(localStorage.getItem("gitlane.repoCommitSource")!)).toEqual({
      [path]: { kind: "manual", id: "p2" },
    });
    expect(localStorage.getItem("gitlane.repoCommitEmail")).toBeNull();
    expect(localStorage.getItem("gitlane.repoProfile")).toBeNull();
    expect(localStorage.getItem("gitlane.repoProfileEmail")).toBeNull();
    // The migrated applied source resolves for the open repo.
    expect(appliedCommitSource()).toEqual({ kind: "manual", id: "p2" });
  });

  it("keys per-repo entries by the repository identity, migrating worktree-path entries", async () => {
    const mainPath = "/repo";
    const wtPath = "/repo/.claude/worktrees/x";
    const wtSummary: RepoSummary = {
      path: wtPath,
      workdir: wtPath,
      headBranch: "d/x",
      headOid: "abc",
      detached: false,
      isWorktree: true,
      mainPath,
    };
    // A pre-GL-130 build stored the applied source under the worktree path.
    localStorage.setItem(
      "gitlane.repoCommitSource",
      JSON.stringify({ [wtPath]: { kind: "manual", id: "p2" } }),
    );
    useRepo.setState({ summary: wtSummary });

    expect(appliedCommitSource()).toEqual({ kind: "manual", id: "p2" });
    const stored = JSON.parse(localStorage.getItem("gitlane.repoCommitSource")!);
    expect(stored[mainPath]).toEqual({ kind: "manual", id: "p2" });
    expect(stored[wtPath]).toBeUndefined();

    // A fresh apply from the worktree persists under the identity key too.
    await useIdentities.getState().applyCommitSource(manualRef("p1"));
    const after = JSON.parse(localStorage.getItem("gitlane.repoCommitSource")!);
    expect(after[mainPath]).toEqual({ kind: "manual", id: "p1" });
    expect(after[wtPath]).toBeUndefined();
  });
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("useIdentities — identity write races", () => {
  it("serializes overlapping applies and publishes only the latest identity", async () => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writes = 0;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      const p = args?.path as string;
      if (cmd === "set_repo_identity") {
        writes += 1;
        if (writes === 1) await firstWrite;
        state.cfg.set(p, { name: args.name as string, email: args.email as string });
        return "ok";
      }
      if (cmd === "repo_identity") return state.cfg.get(p) ?? null;
      return null;
    });

    const first = useIdentities.getState().applyCommitSource(manualRef("p2"));
    await tick();
    const second = useIdentities.getState().applyCommitSource(manualRef("p1"));
    await tick();

    expect(writes).toBe(1);
    releaseFirstWrite();
    await Promise.all([first, second]);

    expect(writes).toBe(2);
    expect(state.cfg.get(path)).toEqual({
      name: "Stepan Personal",
      email: "personal@example.dev",
    });
    expect(useAccounts.getState().repoIdentity?.email).toBe("personal@example.dev");
    expect(appliedCommitSource()).toEqual(manualRef("p1"));
  });

  it("preserves the last successful duplicate-tuple card when the queued apply fails", async () => {
    const duplicateA: GitProfile = {
      ...work,
      id: "duplicate-a",
      label: "Duplicate A",
    };
    const duplicateB: GitProfile = {
      ...duplicateA,
      id: "duplicate-b",
      label: "Duplicate B",
    };
    useIdentities.setState({ manualIdentities: [personal, duplicateA, duplicateB] });

    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    let writes = 0;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      const p = args?.path as string;
      if (cmd === "set_repo_identity") {
        writes += 1;
        if (writes === 1) {
          firstWriteStarted();
          await firstWrite;
          state.cfg.set(p, { name: args.name as string, email: args.email as string });
          return "ok";
        }
        throw new Error("queued duplicate failed");
      }
      if (cmd === "repo_identity") return state.cfg.get(p) ?? null;
      return null;
    });

    const applyingA = useIdentities.getState().applyCommitSource(manualRef(duplicateA.id));
    await firstStarted;
    const applyingB = useIdentities.getState().applyCommitSource(manualRef(duplicateB.id));
    releaseFirstWrite();

    await expect(applyingA).resolves.toBe(true);
    await expect(applyingB).resolves.toBe(false);
    expect(writes).toBe(2);
    expect(state.cfg.get(path)).toEqual({ name: duplicateA.name, email: duplicateA.email });
    expect(useAccounts.getState().repoIdentity).toEqual({
      name: duplicateA.name,
      email: duplicateA.email,
    });
    // Equal name/email tuples cannot disambiguate these cards: the durable
    // applied marker must continue to identify the successful first card.
    expect(appliedCommitSource()).toEqual(manualRef(duplicateA.id));
  });

  it("suppresses a failed intent's stale error after a newer intent starts during hydrate", async () => {
    const showToast = vi.fn();
    const originalShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });

    let releaseFailedHydrate!: () => void;
    const failedHydrate = new Promise<void>((resolve) => {
      releaseFailedHydrate = resolve;
    });
    let failedHydrateStarted!: () => void;
    const hydrateStarted = new Promise<void>((resolve) => {
      failedHydrateStarted = resolve;
    });
    let writes = 0;
    let reads = 0;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      const p = args?.path as string;
      if (cmd === "set_repo_identity") {
        writes += 1;
        if (writes === 1) throw new Error("stale apply failed");
        state.cfg.set(p, { name: args.name as string, email: args.email as string });
        return "ok";
      }
      if (cmd === "repo_identity") {
        reads += 1;
        const snapshot = state.cfg.get(p) ?? null;
        if (reads === 1) {
          failedHydrateStarted();
          await failedHydrate;
        }
        return snapshot;
      }
      return null;
    });

    try {
      const failed = useIdentities.getState().applyCommitSource(manualRef("p2"));
      await hydrateStarted;
      const newer = useIdentities.getState().applyCommitSource(manualRef("p1"));
      await expect(newer).resolves.toBe(true);
      releaseFailedHydrate();
      await expect(failed).resolves.toBe(false);

      expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining("stale apply failed"), "error");
      expect(showToast).not.toHaveBeenCalledWith("This repo commits as Personal");
      expect(appliedCommitSource()).toEqual(manualRef("p1"));
      expect(useAccounts.getState().repoIdentity?.email).toBe(personal.email);
    } finally {
      releaseFailedHydrate();
      useUi.setState({ showToast: originalShowToast });
    }
  });

  it("skips a queued card after it is deleted before execution", async () => {
    let releaseClear!: () => void;
    const blockedClear = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    let clearStarted!: () => void;
    const clearIsRunning = new Promise<void>((resolve) => {
      clearStarted = resolve;
    });
    const calls: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      const p = args?.path as string;
      if (cmd === "clear_repo_identity") {
        calls.push(cmd);
        clearStarted();
        await blockedClear;
        state.cfg.delete(p);
        return "ok";
      }
      if (cmd === "set_repo_identity") {
        calls.push(cmd);
        state.cfg.set(p, { name: args.name as string, email: args.email as string });
        return "ok";
      }
      if (cmd === "repo_identity") return state.cfg.get(p) ?? null;
      return null;
    });

    const clearing = useIdentities.getState().applyCommitSource(null);
    await clearIsRunning;
    const queued = useIdentities.getState().applyCommitSource(manualRef("p2"));
    useIdentities.getState().deleteManualIdentity("p2");
    releaseClear();

    await expect(clearing).resolves.toBe(true);
    await expect(queued).resolves.toBe(false);
    expect(calls).toEqual(["clear_repo_identity"]);
    expect(useIdentities.getState().manualIdentities.some((card) => card.id === "p2")).toBe(false);
    expect(state.cfg.has(path)).toBe(false);
    expect(appliedCommitSource()).toBeNull();
  });

  it("reconciles an older successful apply after a newer queued card is deleted", async () => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let signalFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWriteStarted = resolve;
    });
    const calls: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      const p = args?.path as string;
      if (cmd === "set_repo_identity") {
        calls.push(`${cmd}:${args.email as string}`);
        signalFirstWriteStarted();
        await firstWrite;
        state.cfg.set(p, { name: args.name as string, email: args.email as string });
        return "ok";
      }
      if (cmd === "repo_identity") {
        calls.push(cmd);
        return state.cfg.get(p) ?? null;
      }
      return null;
    });
    useAccounts.setState({
      repoIdentity: { name: "Old Identity", email: "old@example.dev" },
    });

    const applyingWork = useIdentities.getState().applyCommitSource(manualRef("p2"));
    await firstWriteStarted;
    const applyingPersonal = useIdentities.getState().applyCommitSource(manualRef("p1"));
    useIdentities.getState().deleteManualIdentity("p1");
    releaseFirstWrite();

    await expect(applyingWork).resolves.toBe(true);
    await expect(applyingPersonal).resolves.toBe(false);
    expect(calls).toEqual(["set_repo_identity:work@acme.io", "repo_identity"]);
    expect(state.cfg.get(path)).toEqual({ name: work.name, email: work.email });
    expect(appliedCommitSource()).toEqual(manualRef("p2"));
    expect(useAccounts.getState().repoIdentity).toEqual({
      name: work.name,
      email: work.email,
    });
  });

  it("does not resurrect a deleted card marker after its durable write has started", async () => {
    localStorage.setItem(
      "gitlane.repoCommitSource",
      JSON.stringify({ [path]: manualRef("p2") }),
    );

    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let durableWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      durableWriteStarted = resolve;
    });
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      const p = args?.path as string;
      if (cmd === "set_repo_identity") {
        // Model an IPC call whose git-config mutation has completed but whose
        // response is still in flight when the card is deleted.
        state.cfg.set(p, { name: args.name as string, email: args.email as string });
        durableWriteStarted();
        await blockedWrite;
        return "ok";
      }
      if (cmd === "repo_identity") return state.cfg.get(p) ?? null;
      return null;
    });

    const applying = useIdentities.getState().applyCommitSource(manualRef("p2"));
    await writeStarted;
    useIdentities.getState().deleteManualIdentity("p2");
    expect(appliedCommitSource()).toBeNull();
    releaseWrite();

    await expect(applying).resolves.toBe(false);
    expect(appliedCommitSource()).toBeNull();
    expect(state.cfg.get(path)).toEqual({ name: work.name, email: work.email });
    // With its card gone, the completed config tuple is deliberately retained
    // as an unmanaged durable identity and reconciled from the backend.
    expect(useAccounts.getState().repoIdentity).toEqual({ name: work.name, email: work.email });
  });

  it("queues clear behind an in-flight apply so this-computer intent wins", async () => {
    let releaseWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const calls: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      const p = args?.path as string;
      if (cmd === "set_repo_identity") {
        calls.push(cmd);
        await pendingWrite;
        state.cfg.set(p, { name: args.name as string, email: args.email as string });
        return "ok";
      }
      if (cmd === "clear_repo_identity") {
        calls.push(cmd);
        state.cfg.delete(p);
        return "ok";
      }
      if (cmd === "repo_identity") return state.cfg.get(p) ?? null;
      return null;
    });

    const applying = useIdentities.getState().applyCommitSource(manualRef("p2"));
    await tick();
    const clearing = useIdentities.getState().applyCommitSource(null);
    await tick();

    expect(calls).toEqual(["set_repo_identity"]);
    releaseWrite();
    await Promise.all([applying, clearing]);

    expect(calls).toEqual(["set_repo_identity", "clear_repo_identity"]);
    expect(state.cfg.has(path)).toBe(false);
    expect(useAccounts.getState().repoIdentity).toBeNull();
    expect(appliedCommitSource()).toBeNull();
  });

  it("does not publish an applied identity after switching repos before the write resolves", async () => {
    let releaseWrite!: () => void;
    const pendingWrite = new Promise<void>((r) => {
      releaseWrite = r;
    });
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      const p = args?.path as string;
      if (cmd === "set_repo_identity") {
        await pendingWrite;
        state.cfg.set(p, { name: args.name as string, email: args.email as string });
        return "ok";
      }
      if (cmd === "repo_identity") return state.cfg.get(p) ?? null;
      return null;
    });

    const applying = useIdentities.getState().applyCommitSource(manualRef("p2"));
    await tick();
    useRepo.setState({ summary: otherSummary });
    useAccounts.setState({ repoIdentity: { name: "Other Repo", email: "other@example.dev" } });

    releaseWrite();
    await applying;

    expect(state.cfg.get(path)).toEqual({ name: "Stepan Work", email: "work@acme.io" });
    expect(useAccounts.getState().repoIdentity).toEqual({
      name: "Other Repo",
      email: "other@example.dev",
    });
  });

  it("reconciles an apply onto a sibling worktree with the same repository identity", async () => {
    const mainPath = "/repo";
    const firstPath = "/repo-worktrees/first";
    const siblingPath = "/repo-worktrees/sibling";
    const linkedSummary = (worktreePath: string): RepoSummary => ({
      path: worktreePath,
      workdir: worktreePath,
      headBranch: "feature",
      headOid: "abc",
      detached: false,
      isWorktree: true,
      mainPath,
    });
    useRepo.setState({ summary: linkedSummary(firstPath) });
    useAccounts.setState({ repoBindingKey: mainPath, repoIdentity: null });

    let releaseWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    let durableIdentity: { name: string; email: string } | null = null;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "set_repo_identity") {
        expect(args.path).toBe(firstPath);
        signalWriteStarted();
        await pendingWrite;
        durableIdentity = { name: args.name as string, email: args.email as string };
        return "ok";
      }
      if (cmd === "repo_identity") {
        expect(args.path).toBe(siblingPath);
        return durableIdentity;
      }
      return null;
    });

    const applying = useIdentities.getState().applyCommitSource(manualRef("p2"));
    await writeStarted;
    useRepo.setState({ summary: linkedSummary(siblingPath) });
    useAccounts.setState({ repoBindingKey: mainPath, repoIdentity: null });
    releaseWrite();

    await expect(applying).resolves.toBe(true);
    expect(useAccounts.getState().repoIdentity).toEqual({
      name: work.name,
      email: work.email,
    });
    expect(JSON.parse(localStorage.getItem("gitlane.repoCommitSource")!)).toEqual({
      [mainPath]: manualRef("p2"),
    });
  });

  it("publishes the applied identity optimistically and drops a superseded hydrate", async () => {
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<void>((r) => {
      releaseFirstRead = r;
    });
    let reads = 0;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      const p = args?.path as string;
      if (cmd === "set_repo_identity") {
        state.cfg.set(p, { name: args.name as string, email: args.email as string });
        return "ok";
      }
      if (cmd === "repo_identity") {
        reads += 1;
        const snapshot = state.cfg.get(p) ?? null; // value at read-issue time
        if (reads === 1) await firstRead;
        return snapshot;
      }
      return null;
    });

    const apply1 = useIdentities.getState().applyCommitSource(manualRef("p2")); // hydrate hangs
    await tick();
    expect(useAccounts.getState().repoIdentity?.name).toBe("Stepan Work");

    await useIdentities.getState().applyCommitSource(manualRef("p1")); // supersedes
    expect(useAccounts.getState().repoIdentity?.email).toBe("personal@example.dev");

    releaseFirstRead();
    await apply1;
    await tick();
    expect(useAccounts.getState().repoIdentity?.email).toBe("personal@example.dev");
  });

  it("publishes the cleared identity immediately on switch to this computer", async () => {
    let releaseRead!: () => void;
    const slowRead = new Promise<void>((r) => {
      releaseRead = r;
    });
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      const p = args?.path as string;
      if (cmd === "set_repo_identity") {
        state.cfg.set(p, { name: args.name as string, email: args.email as string });
        return "ok";
      }
      if (cmd === "clear_repo_identity") {
        state.cfg.delete(p);
        return "ok";
      }
      if (cmd === "repo_identity") {
        await slowRead;
        return state.cfg.get(p) ?? null;
      }
      return null;
    });

    useAccounts.setState({ repoIdentity: { name: "Stepan Work", email: "work@acme.io" } });
    const clearing = useIdentities.getState().applyCommitSource(null);
    await tick();
    expect(useAccounts.getState().repoIdentity).toBeNull();
    releaseRead();
    await clearing;
    expect(useAccounts.getState().repoIdentity).toBeNull();
  });

  it("saveManualIdentity with an unknown id creates an identity instead of dropping it", () => {
    useIdentities.setState({ manualIdentities: [personal] });
    const saved = useIdentities
      .getState()
      .saveManualIdentity({ id: "ghost", label: "Ghost", name: "G", email: "g@x.dev" });
    expect(saved.label).toBe("Ghost");
    expect(useIdentities.getState().manualIdentities.some((p) => p.label === "Ghost")).toBe(true);
  });
});
