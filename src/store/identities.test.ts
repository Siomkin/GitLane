import { beforeEach, describe, expect, it, vi } from "vitest";

// Simulated repo-local git config so apply/clear/read round-trip like the real
// backend, letting us prove per-repo custom emails survive source switches.
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

describe("useIdentities — custom email persistence across source switches", () => {
  it("restores a per-repo custom email when re-applying a source (A→B→A)", async () => {
    const { applyCommitSource, setCustomEmail } = useIdentities.getState();

    await applyCommitSource(manualRef("p2"));
    expect(useAccounts.getState().repoIdentity).toEqual({ name: "Stepan Work", email: "work@acme.io" });

    await setCustomEmail("stepan@contractor.dev");
    expect(useAccounts.getState().repoIdentity?.email).toBe("stepan@contractor.dev");

    await applyCommitSource(manualRef("p1"));
    expect(useAccounts.getState().repoIdentity?.email).toBe("personal@example.dev");

    await applyCommitSource(manualRef("p2"));
    expect(useAccounts.getState().repoIdentity?.email).toBe("stepan@contractor.dev");
  });

  it("reset-to-default drops the override and re-applies the source email", async () => {
    const { applyCommitSource, setCustomEmail, resetCustomEmail } = useIdentities.getState();
    await applyCommitSource(manualRef("p2"));
    await setCustomEmail("stepan@contractor.dev");

    await resetCustomEmail();
    expect(useAccounts.getState().repoIdentity?.email).toBe("work@acme.io");

    await applyCommitSource(manualRef("p1"));
    await applyCommitSource(manualRef("p2"));
    expect(useAccounts.getState().repoIdentity?.email).toBe("work@acme.io");
  });

  it("scrubs the applied ref (and override) when the applied manual identity is deleted", async () => {
    const { applyCommitSource, setCustomEmail, deleteManualIdentity } = useIdentities.getState();
    await applyCommitSource(manualRef("p2"));
    await setCustomEmail("custom@x.dev");
    expect(appliedCommitSource()).toEqual({ kind: "manual", id: "p2" });

    deleteManualIdentity("p2");
    expect(appliedCommitSource()).toBeNull();
    const overrides = JSON.parse(localStorage.getItem("gitlane.repoCommitEmail") ?? "{}");
    expect(overrides[path]?.["manual:p2"]).toBeUndefined();
  });
});

describe("useIdentities — storage migration and keying", () => {
  it("migrates the pre-GL-130 keys once and deletes them", () => {
    localStorage.setItem("gitlane.repoProfile", JSON.stringify({ [path]: "p2" }));
    localStorage.setItem(
      "gitlane.repoProfileEmail",
      JSON.stringify({ [path]: { p2: "old@custom.dev" } }),
    );

    useIdentities.getState().loadIdentities();

    expect(JSON.parse(localStorage.getItem("gitlane.repoCommitSource")!)).toEqual({
      [path]: { kind: "manual", id: "p2" },
    });
    expect(JSON.parse(localStorage.getItem("gitlane.repoCommitEmail")!)).toEqual({
      [path]: { "manual:p2": "old@custom.dev" },
    });
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
