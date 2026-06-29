import { describe, expect, it } from "vitest";
import { profileInitials, selectProfile, type GitProfile } from "./profiles";

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
  signingKey: "ABCD1234",
  gpgFormat: "openpgp",
  gpgSign: true,
  color: "#2f9e7e",
};
const profiles = [personal, work];

describe("selectProfile", () => {
  it("returns the default option when nothing is pinned locally", () => {
    expect(selectProfile(null, profiles)).toEqual({ kind: "default" });
  });

  it("matches a profile exactly on name + email + signing (no overrides)", () => {
    expect(
      selectProfile(
        { name: "Stepan Work", email: "work@acme.io", signingKey: "ABCD1234", gpgFormat: "openpgp", gpgSign: true },
        profiles,
      ),
    ).toEqual({ kind: "profile", id: "p2", customEmail: false, customSigning: false });
  });

  it("flags a custom email when the name matches but the email differs", () => {
    expect(
      selectProfile(
        { name: "Stepan Work", email: "stepan@personal.dev", signingKey: "ABCD1234", gpgFormat: "openpgp", gpgSign: true },
        profiles,
      ),
    ).toEqual({ kind: "profile", id: "p2", customEmail: true, customSigning: false });
  });

  it("flags custom signing when the key/format/sign flag diverges", () => {
    expect(
      selectProfile({ name: "Stepan Work", email: "work@acme.io", signingKey: "DIFFERENT" }, profiles),
    ).toEqual({ kind: "profile", id: "p2", customEmail: false, customSigning: true });
  });

  it("reports unmanaged when no profile matches the pinned identity", () => {
    expect(selectProfile({ name: "Someone Else", email: "x@y.z" }, profiles)).toEqual({
      kind: "unmanaged",
    });
  });

  it("ignores a stale applied id when the repo's git identity no longer matches it", () => {
    // appliedId points to Work, but user.name was changed externally → unmanaged,
    // not masquerading as Work (git config is the source of truth).
    expect(selectProfile({ name: "Outside Tool", email: "ext@x.dev" }, profiles, "p2")).toEqual({
      kind: "unmanaged",
    });
  });

  it("prefers the applied profile id over name matching (duplicate names + custom email)", () => {
    const dupA: GitProfile = { id: "a", label: "Work", name: "Sam Same", email: "work@x.dev", color: "#1" };
    const dupB: GitProfile = { id: "b", label: "Personal", name: "Sam Same", email: "home@x.dev", color: "#2" };
    const dups = [dupA, dupB];
    const custom = { name: "Sam Same", email: "custom@x.dev" };
    // Without an applied id, duplicate names + a custom email are ambiguous, so
    // the identity is unmanaged rather than an arbitrary guess.
    expect(selectProfile(custom, dups)).toEqual({ kind: "unmanaged" });
    // With the applied id, the correct profile (dupB) is selected.
    expect(selectProfile(custom, dups, "b")).toMatchObject({ kind: "profile", id: "b", customEmail: true });
    // An exact email still disambiguates without an applied id.
    expect(selectProfile({ name: "Sam Same", email: "home@x.dev" }, dups)).toMatchObject({
      kind: "profile",
      id: "b",
      customEmail: false,
    });
  });
});

describe("profileInitials", () => {
  it("uses the first letters of the first two words", () => {
    expect(profileInitials("Work Account")).toBe("WA");
  });
  it("falls back to the first two characters of a single word", () => {
    expect(profileInitials("personal")).toBe("PE");
  });
});
