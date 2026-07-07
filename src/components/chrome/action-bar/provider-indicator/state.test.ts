import { describe, expect, it } from "vitest";
import { ForgeKind } from "../../../../lib/api";
import type { RepoForge } from "../../../../lib/api";
import { deriveProviderState } from "./state";
import type { ProviderAuthCtx } from "./state";

const forge = (over: Partial<RepoForge>): RepoForge => ({
  hasRemote: true,
  kind: ForgeKind.GitHub,
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/owner/repo",
  ...over,
});

const ctx = (over: Partial<ProviderAuthCtx> = {}): ProviderAuthCtx => ({
  accounts: [],
  accountsError: null,
  accountsLoading: false,
  repoAccountRef: null,
  gitlabReady: false,
  ...over,
});

describe("deriveProviderState", () => {
  it("reports missing when there is no remote", () => {
    expect(deriveProviderState(forge({ hasRemote: false, kind: null }), ctx())).toBe("missing");
  });

  it("reports connected for a non-PR forge (repo link works, no PR surface)", () => {
    expect(
      deriveProviderState(forge({ kind: ForgeKind.Bitbucket, forge: "Bitbucket" }), ctx()),
    ).toBe("connected");
  });

  it("reports GitLab connected when MRs can be fetched, else needs-auth (GL-145)", () => {
    const gitlab = forge({ kind: ForgeKind.GitLab, forge: "GitLab", host: "gitlab.com" });
    expect(deriveProviderState(gitlab, ctx({ gitlabReady: true }))).toBe("connected");
    expect(deriveProviderState(gitlab, ctx({ gitlabReady: false }))).toBe("needs-auth");
  });

  it("reports unsupported only for a remote on an unrecognised host", () => {
    expect(
      deriveProviderState(forge({ kind: null, forge: null, host: "git.internal.example" }), ctx()),
    ).toBe("unsupported");
  });

  it("reports error when the accounts probe failed (gh missing)", () => {
    expect(deriveProviderState(forge({}), ctx({ accountsError: "gh: not found" }))).toBe("error");
  });

  it("reports needs-auth for a GitHub remote with no matching account", () => {
    expect(deriveProviderState(forge({}), ctx())).toBe("needs-auth");
  });

  it("reports connected when an account matches the host", () => {
    expect(
      deriveProviderState(forge({}), ctx({ accounts: [{ host: "github.com" }] })),
    ).toBe("connected");
  });

  it("reports connected when the repo is bound to a matching account", () => {
    expect(
      deriveProviderState(forge({}), ctx({ repoAccountRef: { host: "github.com" } })),
    ).toBe("connected");
  });

  it("stays optimistic (connected) while accounts are still loading", () => {
    expect(deriveProviderState(forge({}), ctx({ accountsLoading: true }))).toBe("connected");
  });
});
