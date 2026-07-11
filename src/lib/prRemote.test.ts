import { describe, expect, it } from "vitest";
import { ForgeKind, type RepoForge } from "./api";
import { accountMatchesPrRemote, prRemoteHost } from "./prRemote";

const forge = (host: string | null): RepoForge => ({
  hasRemote: host !== null,
  kind: host ? ForgeKind.GitHub : null,
  forge: host ? "GitHub" : null,
  host,
  webUrl: host ? `https://${host}/o/r` : null,
});

describe("prRemoteHost", () => {
  it("normalizes the forge host to lowercase", () => {
    expect(prRemoteHost(forge("GitHub.Example.COM"))).toBe("github.example.com");
  });

  it("is null while the forge is unknown or has no host", () => {
    expect(prRemoteHost(null)).toBeNull();
    expect(prRemoteHost(forge(null))).toBeNull();
  });
});

describe("accountMatchesPrRemote", () => {
  it("matches hosts case-insensitively in both directions", () => {
    expect(accountMatchesPrRemote({ host: "GITHUB.com" }, forge("github.COM"))).toBe(true);
  });

  it("rejects a different host", () => {
    expect(accountMatchesPrRemote({ host: "github.com" }, forge("ghe.corp.example"))).toBe(false);
  });

  it("restricts nothing while the host is unknown — the backend stays the enforcement layer", () => {
    expect(accountMatchesPrRemote({ host: "github.com" }, null)).toBe(true);
    expect(accountMatchesPrRemote({ host: "github.com" }, forge(null))).toBe(true);
  });
});
