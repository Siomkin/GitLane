// The PR-API account binding (repo-level, v2 shape). Per-REMOTE accounts are
// git-native now (the https URL's username) and tested via lib/remotes +
// accounts store derivation.
import { describe, expect, it } from "vitest";

import type { GithubAccountRef } from "../lib/api";
import {
  accountKey,
  accountMatchesLegacy,
  resolvePrAccount,
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
    expect(resolvePrAccount({ version: 2, ...ref() }, [alice])).toBe(alice);
  });

  it("falls back to {provider, host, login} when the id degraded (GL-119)", () => {
    const unhealthyAlice = account({ ref: ref({ accountId: "alice" }) });
    expect(resolvePrAccount({ version: 2, ...ref({ accountId: "1001" }) }, [unhealthyAlice])).toBe(
      unhealthyAlice,
    );
  });

  it("resolves a legacy string loosely", () => {
    expect(resolvePrAccount("alice", [alice])).toBe(alice);
    expect(accountMatchesLegacy(alice, "alice")).toBe(true);
  });

  it("keeps an explicit unbound durable", () => {
    expect(resolvePrAccount({ version: 2, unbound: true }, [alice])).toBe("unbound");
  });

  it("leaves interim GL-129 v3 migration to the accounts store", () => {
    expect(resolvePrAccount({ version: 3, remotes: { origin: ref() } }, [alice])).toBe("unset");
    expect(resolvePrAccount(undefined, [alice])).toBe("unset");
  });

  it("does not cross-match a different login on the same host", () => {
    const bob = account({ ref: ref({ accountId: "2002", login: "bob" }) });
    expect(resolvePrAccount({ version: 2, ...ref({ accountId: "9999" }) }, [bob])).toBe("unset");
  });
});
