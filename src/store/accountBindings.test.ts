// Migration + resolution rules for per-remote account bindings (GL-129).
import { describe, expect, it } from "vitest";

import type { GithubAccountRef } from "../lib/api";
import {
  accountKey,
  isV3Entry,
  migrateRepoAccountEntry,
  resolveRemoteBinding,
  type BindableAccount,
  type RepoAccountBindingsV3,
} from "./accountBindings";

const ref = (over: Partial<GithubAccountRef> = {}): GithubAccountRef => ({
  provider: "gh",
  host: "github.com",
  accountId: "1001",
  login: "alice",
  ...over,
});

const account = (over: Partial<BindableAccount> & { ref?: GithubAccountRef } = {}): BindableAccount => {
  const r = over.ref ?? ref();
  return {
    id: accountKey(r),
    provider: r.provider,
    host: r.host,
    accountId: r.accountId,
    login: r.login,
    username: over.username ?? r.login,
    ref: r,
    ...over,
    // `id` derives from the ref unless the test overrides it explicitly.
    ...(over.id ? { id: over.id } : {}),
  };
};

describe("migrateRepoAccountEntry", () => {
  it("passes a v3 entry through untouched", () => {
    const v3: RepoAccountBindingsV3 = { version: 3, remotes: { origin: ref() } };
    expect(migrateRepoAccountEntry(v3, "origin")).toBe(v3);
  });

  it("turns an absent entry into an empty v3 shape without needing a default remote", () => {
    expect(migrateRepoAccountEntry(undefined, null)).toEqual({ version: 3, remotes: {} });
  });

  it("attaches a v2 bound entry to the default remote", () => {
    expect(migrateRepoAccountEntry({ version: 2, ...ref() }, "origin")).toEqual({
      version: 3,
      remotes: { origin: ref() },
    });
  });

  it("attaches a v2 unbound entry to the default remote as an explicit unbound", () => {
    expect(migrateRepoAccountEntry({ version: 2, unbound: true }, "upstream")).toEqual({
      version: 3,
      remotes: { upstream: { unbound: true } },
    });
  });

  it("attaches a legacy string to the default remote unresolved", () => {
    expect(migrateRepoAccountEntry("alice", "origin")).toEqual({
      version: 3,
      remotes: { origin: "alice" },
    });
  });

  it("defers v2/legacy migration until the default remote is known", () => {
    expect(migrateRepoAccountEntry({ version: 2, ...ref() }, null)).toBeNull();
    expect(migrateRepoAccountEntry("alice", null)).toBeNull();
    expect(migrateRepoAccountEntry({ version: 2, unbound: true }, null)).toBeNull();
  });

  it("is idempotent: migrating a migrated entry changes nothing", () => {
    const once = migrateRepoAccountEntry({ version: 2, ...ref() }, "origin")!;
    expect(migrateRepoAccountEntry(once, "origin")).toBe(once);
    expect(isV3Entry(once)).toBe(true);
  });
});

describe("resolveRemoteBinding", () => {
  const alice = account();
  const bob = account({ ref: ref({ accountId: "2002", login: "bob" }) });

  const entry = (remotes: RepoAccountBindingsV3["remotes"]): RepoAccountBindingsV3 => ({
    version: 3,
    remotes,
  });

  it("resolves a bound ref by exact account id", () => {
    const res = resolveRemoteBinding(entry({ origin: ref() }), "origin", "github.com", [alice, bob], null);
    expect(res.account).toBe(alice);
    expect(res.rewrite).toBeNull();
  });

  it("falls back to {provider, host, login} when the id does not match (GL-119)", () => {
    // Unhealthy account: its live id degraded to the login, but the stored
    // binding still carries the numeric id.
    const unhealthyAlice = account({ ref: ref({ accountId: "alice" }) });
    const res = resolveRemoteBinding(
      entry({ origin: ref({ accountId: "1001" }) }),
      "origin",
      "github.com",
      [unhealthyAlice, bob],
      null,
    );
    expect(res.account).toBe(unhealthyAlice);
    // The stored binding is kept so it re-pins to the numeric id once healthy.
    expect(res.rewrite).toBeNull();
  });

  it("resolves a legacy string and reports the ref to persist", () => {
    const res = resolveRemoteBinding(entry({ origin: "alice" }), "origin", "github.com", [alice], null);
    expect(res.account).toBe(alice);
    expect(res.rewrite).toEqual(alice.ref);
  });

  it("keeps an unresolvable legacy string pending without a rewrite", () => {
    const res = resolveRemoteBinding(entry({ origin: "carol" }), "origin", "github.com", [alice], null);
    expect(res.account).toBeNull();
    expect(res.rewrite).toBeNull();
  });

  it("honours an explicit unbound (system git credentials), ignoring the active account", () => {
    const res = resolveRemoteBinding(
      entry({ origin: { unbound: true } }),
      "origin",
      "github.com",
      [alice],
      alice.id,
    );
    expect(res.account).toBeNull();
  });

  it("defaults an unconfigured remote to the active account when the host matches", () => {
    const res = resolveRemoteBinding(entry({}), "origin", "github.com", [alice, bob], alice.id);
    expect(res.account).toBe(alice);
  });

  it("never defaults the active account onto a host it cannot authenticate", () => {
    const res = resolveRemoteBinding(entry({}), "bucket", "bitbucket.org", [alice], alice.id);
    expect(res.account).toBeNull();
  });

  it("yields no account for an unconfigured remote with an unparsable host", () => {
    const res = resolveRemoteBinding(entry({}), "local", null, [alice], alice.id);
    expect(res.account).toBeNull();
  });
});
