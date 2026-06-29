import { beforeEach, describe, expect, it, vi } from "vitest";

// Simulated repo-local git config so apply/clear/read round-trip like the real
// backend, letting us prove the per-repo custom email survives a profile switch.
const state = vi.hoisted(() => ({ cfg: new Map<string, { name: string; email: string }>() }));
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "../lib/api";
import { useRepo } from "./repo";
import { useAccounts } from "./accounts";
import { appliedProfileId, useProfiles } from "./profiles";
import type { GitProfile } from "../lib/profiles";

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
  useProfiles.setState({ profiles: [personal, work], defaultIdentity: null });
});

describe("useProfiles — custom email persistence across profile switches", () => {
  it("restores a per-repo custom email when re-applying a profile (A→B→A)", async () => {
    const { applyProfile, setCustomEmail } = useProfiles.getState();

    // Apply Work → repo commits as Work's own email.
    await applyProfile("p2");
    expect(useAccounts.getState().repoIdentity).toEqual({ name: "Stepan Work", email: "work@acme.io" });

    // Override the commit email by hand for this repo.
    await setCustomEmail("stepan@contractor.dev");
    expect(useAccounts.getState().repoIdentity?.email).toBe("stepan@contractor.dev");

    // Switch away to Personal…
    await applyProfile("p1");
    expect(useAccounts.getState().repoIdentity).toEqual({
      name: "Stepan Personal",
      email: "personal@example.dev",
    });

    // …and back to Work: the hand-edited email must come back, not Work's default.
    await applyProfile("p2");
    expect(useAccounts.getState().repoIdentity?.email).toBe("stepan@contractor.dev");
  });

  it("reset-to-default drops the override and re-applies the profile email", async () => {
    const { applyProfile, setCustomEmail, resetCustomEmail } = useProfiles.getState();
    await applyProfile("p2");
    await setCustomEmail("stepan@contractor.dev");
    expect(useAccounts.getState().repoIdentity?.email).toBe("stepan@contractor.dev");

    await resetCustomEmail();
    expect(useAccounts.getState().repoIdentity?.email).toBe("work@acme.io");

    // The override is gone, so switching away and back no longer restores it.
    await applyProfile("p1");
    await applyProfile("p2");
    expect(useAccounts.getState().repoIdentity?.email).toBe("work@acme.io");
  });

  it("scrubs the applied id (and override) when the applied profile is deleted", async () => {
    const { applyProfile, setCustomEmail, deleteProfile } = useProfiles.getState();
    await applyProfile("p2");
    await setCustomEmail("custom@x.dev");
    expect(appliedProfileId(path)).toBe("p2");

    deleteProfile("p2");
    // No stale applied id remains, so selection can't fall back to a wrong duplicate.
    expect(appliedProfileId(path)).toBeNull();
    // The orphaned custom-email override is scrubbed too.
    const overrides = JSON.parse(localStorage.getItem("gitlane.repoProfileEmail") ?? "{}");
    expect(overrides[path]?.p2).toBeUndefined();
  });
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("useProfiles — identity write races", () => {
  it("publishes the applied identity optimistically and drops a superseded hydrate", async () => {
    // The first hydrate read snapshots the config at call time, then hangs, so
    // it lands *after* a newer apply — it must be dropped by the generation guard.
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

    const apply1 = useProfiles.getState().applyProfile("p2"); // Work; its hydrate hangs
    await tick();
    // Optimistic pin already reflects Work, before any reconcile read returns.
    expect(useAccounts.getState().repoIdentity?.name).toBe("Stepan Work");

    await useProfiles.getState().applyProfile("p1"); // Personal — supersedes
    expect(useAccounts.getState().repoIdentity?.email).toBe("personal@example.dev");

    releaseFirstRead(); // the stale Work hydrate finally resolves
    await apply1;
    await tick();
    expect(useAccounts.getState().repoIdentity?.email).toBe("personal@example.dev");
  });

  it("publishes the cleared identity immediately on switch to Default (before hydrate)", async () => {
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
    const clearing = useProfiles.getState().applyProfile(null);
    await tick();
    // Identity is cleared right away — a commit in the hydrate window won't pin Work.
    expect(useAccounts.getState().repoIdentity).toBeNull();
    releaseRead();
    await clearing;
    expect(useAccounts.getState().repoIdentity).toBeNull();
  });

  it("saveProfile with an unknown id creates a profile instead of dropping it", () => {
    useProfiles.setState({ profiles: [personal] });
    const saved = useProfiles.getState().saveProfile({ id: "ghost", label: "Ghost", name: "G", email: "g@x.dev" });
    expect(saved.label).toBe("Ghost");
    expect(useProfiles.getState().profiles.some((p) => p.label === "Ghost")).toBe(true);
  });
});
