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
