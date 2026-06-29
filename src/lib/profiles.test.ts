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

  it("matches a profile exactly on name + email (no custom email)", () => {
    expect(selectProfile({ name: "Stepan Work", email: "work@acme.io" }, profiles)).toEqual({
      kind: "profile",
      id: "p2",
      customEmail: false,
    });
  });

  it("flags a custom email when the name matches but the email differs", () => {
    expect(selectProfile({ name: "Stepan Work", email: "stepan@personal.dev" }, profiles)).toEqual({
      kind: "profile",
      id: "p2",
      customEmail: true,
    });
  });

  it("reports unmanaged when no profile matches the pinned identity", () => {
    expect(selectProfile({ name: "Someone Else", email: "x@y.z" }, profiles)).toEqual({
      kind: "unmanaged",
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
