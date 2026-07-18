// The localStorage metadata layer (GL-157 split out of accounts.ts): typed
// map round-trips, the NUL-separated token key, deterministic token selection
// wiring, and the worktree-path → repo-identity key migration (GL-109).
import { beforeEach, describe, expect, it } from "vitest";

import {
  migratePathKey,
  providerTokenKey,
  readBindings,
  readForgeCredentials,
  readIdentities,
  readProviderTokens,
  writeBindings,
  writeProviderTokens,
  type StoredProviderToken,
} from "./accountsStorage";

const NUL = String.fromCharCode(0);

const token = (over: Partial<StoredProviderToken> = {}): StoredProviderToken => ({
  provider: "gitlab",
  credentialHost: "gitlab.com",
  accountId: "alice",
  login: "alice",
  savedAt: 1,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
});

describe("providerTokenKey", () => {
  it("joins host and login with a NUL so the fields can never collide", () => {
    expect(providerTokenKey("gitlab.com", "alice")).toBe(`gitlab.com${NUL}alice`);
    // A crafted host/login pair must not alias another key (the reason for NUL).
    expect(providerTokenKey("a.b", "c")).not.toBe(providerTokenKey("a", "b.c"));
  });

  it("normalizes case and whitespace so matching is case-insensitive", () => {
    expect(providerTokenKey(" GitLab.com ", " Alice ")).toBe(providerTokenKey("gitlab.com", "alice"));
  });
});

describe("localStorage maps", () => {
  it("round-trips a written map and returns {} for absent or corrupt values", () => {
    expect(readBindings()).toEqual({});
    writeBindings({ "/repo": { version: 2, unbound: true } });
    expect(readBindings()).toEqual({ "/repo": { version: 2, unbound: true } });

    localStorage.setItem("gitlane.providerTokens", "not json");
    expect(readProviderTokens()).toEqual({});
    localStorage.setItem("gitlane.providerTokens", '"a string"');
    expect(readProviderTokens()).toEqual({});
  });

  it("keeps the provider-token metadata under its keyed map", () => {
    const t = token();
    writeProviderTokens({ [providerTokenKey(t.credentialHost, t.login)]: t });
    expect(readProviderTokens()[providerTokenKey("gitlab.com", "alice")]).toEqual(t);
  });

  it("keeps valid rows while rejecting malformed persisted account metadata", () => {
    localStorage.setItem(
      "gitlane.repoAccounts",
      JSON.stringify({
        "/valid": { version: 2, provider: "gh", host: "github.com", accountId: "1", login: "alice" },
        "/invalid": { version: 2, provider: "unknown", host: "github.com" },
      }),
    );
    localStorage.setItem(
      "gitlane.repoIdentity",
      JSON.stringify({
        "/valid": { name: "Alice", email: "alice@example.com", gpgSign: true },
        "/invalid": { name: "Mallory", email: 42 },
      }),
    );
    localStorage.setItem(
      "gitlane.forgeCredentials",
      JSON.stringify({
        gitlab: {
          provider: "gitlab",
          credentialHost: "gitlab.com",
          path: null,
          username: "alice",
          helper: "store",
          savedAt: 1,
        },
        bitbucket: {
          provider: "gitea",
          credentialHost: "gitea.example",
          path: null,
          username: "mallory",
          helper: "store",
          savedAt: 1,
        },
      }),
    );

    expect(readBindings()).toEqual({
      "/valid": { version: 2, provider: "gh", host: "github.com", accountId: "1", login: "alice" },
    });
    expect(readIdentities()).toEqual({
      "/valid": { name: "Alice", email: "alice@example.com", gpgSign: true },
    });
    expect(Object.keys(readForgeCredentials())).toEqual(["gitlab"]);
  });

  it("rejects provider-token rows with secret fields or mismatched lookup keys", () => {
    const valid = token();
    const validKey = providerTokenKey(valid.credentialHost, valid.login);
    localStorage.setItem(
      "gitlane.providerTokens",
      JSON.stringify({
        [validKey]: valid,
        [providerTokenKey("gitlab.com", "mallory")]: { ...token({ login: "mallory" }), token: "must-not-enter-state" },
        [providerTokenKey("gitlab.com", "wrong")]: token({ login: "bob" }),
      }),
    );

    expect(readProviderTokens()).toEqual({ [validKey]: valid });
  });
});

describe("migratePathKey (GL-109)", () => {
  it("moves a worktree-path entry to the repo-identity key", () => {
    const map: Record<string, string> = { "/repo/wt": "value" };
    expect(migratePathKey(map, "/repo", "/repo/wt")).toBe(true);
    expect(map).toEqual({ "/repo": "value" });
  });

  it("drops the stale worktree shadow when the identity key already has a value", () => {
    const map: Record<string, string> = { "/repo": "keep", "/repo/wt": "stale" };
    expect(migratePathKey(map, "/repo", "/repo/wt")).toBe(true);
    expect(map).toEqual({ "/repo": "keep" });
  });

  it("reports no change when the keys are equal or nothing is stored under the path", () => {
    const map: Record<string, string> = { "/repo": "keep" };
    expect(migratePathKey(map, "/repo", "/repo")).toBe(false);
    expect(migratePathKey(map, "/repo", "/elsewhere")).toBe(false);
    expect(map).toEqual({ "/repo": "keep" });
  });
});
