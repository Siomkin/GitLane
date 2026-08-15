// The PR-API account binding (repo-level, v2 shape). Per-REMOTE accounts are
// git-native now (the https URL's username) and tested via lib/remotes +
// accounts store derivation.
import { describe, expect, it } from "vitest";

import type { GithubAccountRef } from "@/lib/api";
import {
  accountKey,
  accountMatchesLegacy,
  accountMatchesRemoteHost,
  legacyDefaultSelection,
  prEntryFromRemoteBinding,
  resolvePrAccount,
  resolveRemoteBinding,
  selectDefaultAccount,
  type BindableAccount,
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
    ...(over.id ? { id: over.id } : {}),
  };
};

describe("resolvePrAccount", () => {
  const alice = account();

  it("resolves a v2 binding by exact account id", () => {
    expect(resolvePrAccount({ version: 2, ...ref() }, [alice])).toEqual({ kind: "account", account: alice });
  });

  it("falls back to {provider, host, login} when the id degraded (GL-119)", () => {
    const unhealthyAlice = account({ ref: ref({ accountId: "alice" }) });
    expect(resolvePrAccount({ version: 2, ...ref({ accountId: "1001" }) }, [unhealthyAlice])).toEqual({
      kind: "account",
      account: unhealthyAlice,
    });
  });

  it("resolves a legacy string loosely", () => {
    expect(resolvePrAccount("alice", [alice])).toEqual({ kind: "account", account: alice });
    expect(accountMatchesLegacy(alice, "alice")).toBe(true);
  });

  it("keeps an explicit unbound durable", () => {
    expect(resolvePrAccount({ version: 2, unbound: true }, [alice])).toEqual({ kind: "unbound" });
  });

  it("leaves interim GL-129 v3 migration to the accounts store", () => {
    expect(resolvePrAccount({ version: 3, remotes: { origin: ref() } }, [alice])).toEqual({ kind: "unset" });
    expect(resolvePrAccount(undefined, [alice])).toEqual({ kind: "unset" });
  });

  it("does not cross-match a different login on the same host", () => {
    const bob = account({ ref: ref({ accountId: "2002", login: "bob" }) });
    expect(resolvePrAccount({ version: 2, ...ref({ accountId: "9999" }) }, [bob])).toEqual({ kind: "unset" });
  });
});

describe("resolveRemoteBinding (interim GL-129 v3 values)", () => {
  const alice = account();

  it("resolves a per-remote v2-shaped ref, distinguishing unresolved from unset", () => {
    expect(resolveRemoteBinding(ref(), [alice])).toEqual({ kind: "account", account: alice });
    expect(resolveRemoteBinding(undefined, [alice])).toEqual({ kind: "unset" });
    expect(resolveRemoteBinding(ref({ accountId: "9999", login: "carol" }), [alice])).toEqual({
      kind: "unresolved",
    });
  });

  it("resolves a legacy string, failing to unresolved (not unset) when unmatched", () => {
    expect(resolveRemoteBinding("alice", [alice])).toEqual({ kind: "account", account: alice });
    expect(resolveRemoteBinding("carol", [alice])).toEqual({ kind: "unresolved" });
  });

  it("keeps an explicit unbound", () => {
    expect(resolveRemoteBinding({ unbound: true }, [alice])).toEqual({ kind: "unbound" });
  });
});

describe("prEntryFromRemoteBinding", () => {
  const alice = account();

  it("collapses a resolved binding to a v2 PR entry", () => {
    expect(prEntryFromRemoteBinding(ref(), [alice])).toEqual({ version: 2, ...alice.ref });
  });

  it("keeps unbound durable and drops unset/unresolved", () => {
    expect(prEntryFromRemoteBinding({ unbound: true }, [alice])).toEqual({
      version: 2,
      unbound: true,
    });
    expect(prEntryFromRemoteBinding(undefined, [alice])).toBeUndefined();
    expect(prEntryFromRemoteBinding("carol", [alice])).toBeUndefined();
  });
});

describe("legacyDefaultSelection", () => {
  const alice = account();

  it("resolves a v3 map through its default-remote entry", () => {
    const entry = { version: 3 as const, remotes: { origin: ref(), fork: "carol" } };
    expect(legacyDefaultSelection(entry, "origin", [alice])).toEqual({ kind: "account", account: alice });
    expect(legacyDefaultSelection(entry, "fork", [alice])).toEqual({ kind: "unresolved" });
    expect(legacyDefaultSelection(entry, null, [alice])).toEqual({ kind: "unset" });
  });

  it("marks an existing-but-unmatched v2 entry unresolved so identity doesn't silently switch", () => {
    expect(
      legacyDefaultSelection({ version: 2, ...ref({ accountId: "9999", login: "x" }) }, "origin", [alice]),
    ).toEqual({ kind: "unresolved" });
    expect(legacyDefaultSelection(undefined, "origin", [alice])).toEqual({ kind: "unset" });
    expect(legacyDefaultSelection({ version: 2, ...ref() }, "origin", [alice])).toEqual({
      kind: "account",
      account: alice,
    });
  });
});

describe("selectDefaultAccount", () => {
  const alice = account();
  const bob = account({ ref: ref({ accountId: "2002", login: "bob" }) });

  it.each([
    {
      name: "derived-from-URL wins over a stored account",
      defaultRemote: { ssh: false },
      derived: alice,
      stored: { kind: "account" as const, account: bob },
      activeAccountId: bob.id,
      expected: alice,
    },
    {
      name: "legacy stored account is the upgrade bridge when the HTTPS URL has no username",
      defaultRemote: { ssh: false },
      derived: null,
      stored: { kind: "account" as const, account: alice },
      activeAccountId: bob.id,
      expected: alice,
    },
    {
      name: "SSH (or no remote) falls back to the gh active account when stored is unset",
      defaultRemote: { ssh: true },
      derived: null,
      stored: { kind: "unset" as const },
      activeAccountId: alice.id,
      expected: alice,
    },
    {
      name: "no remote falls back to the gh active account when stored is unset",
      defaultRemote: null,
      derived: null,
      stored: { kind: "unset" as const },
      activeAccountId: alice.id,
      expected: alice,
    },
    {
      name: "HTTPS unset does not fall back to the active account",
      defaultRemote: { ssh: false },
      derived: null,
      stored: { kind: "unset" as const },
      activeAccountId: alice.id,
      expected: null,
    },
    {
      name: "unbound means no account, do not fall back (SSH)",
      defaultRemote: { ssh: true },
      derived: null,
      stored: { kind: "unbound" as const },
      activeAccountId: alice.id,
      expected: null,
    },
    {
      name: "unresolved means no account, do not fall back (SSH)",
      defaultRemote: { ssh: true },
      derived: null,
      stored: { kind: "unresolved" as const },
      activeAccountId: alice.id,
      expected: null,
    },
  ])("$name", ({ defaultRemote, derived, stored, activeAccountId, expected }) => {
    expect(
      selectDefaultAccount({
        defaultRemote,
        derived,
        stored,
        activeAccountId,
        accounts: [alice, bob],
      }),
    ).toBe(expected);
  });
});

describe("accountMatchesRemoteHost", () => {
  it("matches on the credential authority, tolerating a www.-prefixed remote host", () => {
    expect(accountMatchesRemoteHost({ host: "gitlab.com" }, { host: "gitlab.com", credentialHost: "gitlab.com" })).toBe(true);
    expect(accountMatchesRemoteHost({ host: "gitlab.com" }, { host: "gitlab.com", credentialHost: "www.gitlab.com" })).toBe(true);
    expect(accountMatchesRemoteHost({ host: "gitlab.com" }, { host: "example.com", credentialHost: "example.com" })).toBe(false);
    expect(accountMatchesRemoteHost({ host: "gitlab.com" }, { host: null, credentialHost: null })).toBe(false);
  });
});
