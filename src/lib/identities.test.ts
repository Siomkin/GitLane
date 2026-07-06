import { describe, expect, it } from "vitest";

import type { RepoIdentity } from "./api";
import type { GitProfile } from "./profiles";
import { migrateAppliedProfileMap, noreplyEmail, selectCommitSource } from "./identities";

const card = (over: Partial<GitProfile> = {}): GitProfile => ({
  id: "p1",
  label: "Personal",
  name: "Alex Dev",
  email: "alex@personal.dev",
  color: "#5b8def",
  ...over,
});

const identity = (over: Partial<RepoIdentity> = {}): RepoIdentity => ({
  name: "Alex Dev",
  email: "alex@personal.dev",
  ...over,
});

describe("noreplyEmail", () => {
  it("builds the noreply address from the numeric id, per host", () => {
    expect(noreplyEmail({ accountId: "1001", login: "alexdev", host: "github.com" })).toBe(
      "1001+alexdev@users.noreply.github.com",
    );
    expect(noreplyEmail({ accountId: "1001", login: "alexdev", host: "ghe.corp" })).toBe(
      "1001+alexdev@users.noreply.ghe.corp",
    );
  });

  it("returns null when the id degraded to the login (unresolved account)", () => {
    expect(noreplyEmail({ accountId: "alexdev", login: "alexdev", host: "github.com" })).toBeNull();
  });
});

describe("selectCommitSource", () => {
  it("nothing pinned → this computer", () => {
    expect(selectCommitSource(null, [card()], null)).toEqual({ kind: "computer" });
  });

  it("matches a card by exact name+email", () => {
    expect(selectCommitSource(identity(), [card()], null)).toMatchObject({
      kind: "manual",
      id: "p1",
      customName: false,
    });
  });

  it("matches email case-insensitively", () => {
    expect(selectCommitSource(identity({ email: "Alex@Personal.Dev" }), [card()], null)).toMatchObject({
      kind: "manual",
      id: "p1",
    });
  });

  it("treats a redundant repo-local author equal to global config as this computer", () => {
    expect(
      selectCommitSource(
        identity({ signingKey: "KEY1", gpgFormat: "ssh", gpgSign: true }),
        [],
        null,
        identity({ signingKey: "KEY1", gpgFormat: "ssh", gpgSign: true }),
      ),
    ).toEqual({ kind: "computer" });
  });

  it("still treats same name/email as this computer when signing differs", () => {
    expect(
      selectCommitSource(
        identity({ signingKey: "KEY2", gpgFormat: "ssh", gpgSign: true }),
        [],
        null,
        identity({ signingKey: "KEY1", gpgFormat: "ssh", gpgSign: true }),
      ),
    ).toEqual({ kind: "computer" });
  });

  it("a custom author name never breaks an applied card (attribution follows the email)", () => {
    const sel = selectCommitSource(identity({ name: "Alexander S." }), [card()], {
      kind: "manual",
      id: "p1",
    });
    expect(sel).toMatchObject({ kind: "manual", id: "p1", customName: true });
  });

  it("an email the card doesn't know breaks the applied claim", () => {
    const sel = selectCommitSource(identity({ email: "somewhere@else.dev" }), [card()], {
      kind: "manual",
      id: "p1",
    });
    expect(sel).toEqual({ kind: "unmanaged" });
  });

  it("matches an unambiguous email-only hit without an applied ref", () => {
    const sel = selectCommitSource(identity({ name: "Renamed" }), [card()], null);
    expect(sel).toMatchObject({ kind: "manual", id: "p1", customName: true });
  });

  it("refuses an ambiguous email match", () => {
    const two = [card(), card({ id: "p2", label: "Work", name: "Alex Work" })];
    const sel = selectCommitSource(identity({ name: "Someone" }), two, null);
    expect(sel).toEqual({ kind: "unmanaged" });
  });

  it("reports custom signing when the pin diverges from the card", () => {
    const signed = card({ signingKey: "KEY1", gpgSign: true });
    const sel = selectCommitSource(identity(), [signed], null);
    expect(sel).toMatchObject({ kind: "manual", customSigning: true });
  });

  it("an unknown identity is unmanaged (legitimate, not an error)", () => {
    expect(selectCommitSource(identity({ email: "untracked@x.dev" }), [card()], null)).toEqual({
      kind: "unmanaged",
    });
  });
});

describe("storage migrations", () => {
  it("migrates the applied-profile map to manual source refs", () => {
    expect(
      migrateAppliedProfileMap({ "/repo": "p1", "/other": "", "/bad": 42 as unknown as string }),
    ).toEqual({ "/repo": { kind: "manual", id: "p1" } });
  });
});
