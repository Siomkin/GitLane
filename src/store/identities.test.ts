import { beforeEach, describe, expect, it, vi } from "vitest";

// Simulated repo-local git config so apply/clear/read round-trip like the real
// backend.
const state = vi.hoisted(() => ({
  cfg: new Map<string, { name: string; email: string }>(),
}));
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "../lib/api";
import type { GitProfile } from "../lib/profiles";
import type { CommitSourceRef } from "../lib/identities";
import { useRepo } from "./repo";
import { useAccounts } from "./accounts";
import { appliedCommitSource, useIdentities } from "./identities";

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
  useAccounts.setState({ repoIdentity: null });
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
