import { describe, expect, it } from "vitest";
import { validateBranchName } from "./refName";

describe("validateBranchName", () => {
  it("accepts ordinary branch names", () => {
    for (const ok of ["main", "feature/my-branch", "release-1.2", "user/GL-120", "a.b.c"]) {
      expect(validateBranchName(ok)).toBeNull();
    }
  });

  it("rejects an empty or whitespace name", () => {
    expect(validateBranchName("")).not.toBeNull();
    expect(validateBranchName("   ")).not.toBeNull();
  });

  it("rejects a leading dash (would read as a git option)", () => {
    expect(validateBranchName("-x")).not.toBeNull();
  });

  it("rejects leading/trailing slashes and doubled slashes", () => {
    expect(validateBranchName("/foo")).not.toBeNull();
    expect(validateBranchName("foo/")).not.toBeNull();
    expect(validateBranchName("foo//bar")).not.toBeNull();
  });

  it("rejects git's reserved punctuation and whitespace", () => {
    for (const bad of ["a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b"]) {
      expect(validateBranchName(bad)).not.toBeNull();
    }
  });

  it("rejects sequences git forbids", () => {
    expect(validateBranchName("a..b")).not.toBeNull();
    expect(validateBranchName("a@{b")).not.toBeNull();
    expect(validateBranchName("@")).not.toBeNull();
    expect(validateBranchName("foo.")).not.toBeNull();
  });

  it("rejects components starting with a dot or ending in .lock", () => {
    expect(validateBranchName(".hidden")).not.toBeNull();
    expect(validateBranchName("feature/.hidden")).not.toBeNull();
    expect(validateBranchName("foo.lock")).not.toBeNull();
    expect(validateBranchName("feature/bar.lock")).not.toBeNull();
  });

  it("rejects the reserved HEAD pseudo-ref and its cousins", () => {
    // `git check-ref-format --branch HEAD` fails: a branch can't be named after
    // a pseudo-ref, or it becomes ambiguous with the real one.
    for (const bad of ["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
      expect(validateBranchName(bad)).not.toBeNull();
    }
  });

  it("rejects control characters", () => {
    // A raw tab and a raw NUL are both rejected; built via fromCharCode so the
    // test source itself stays plain ASCII text (not a binary file).
    expect(validateBranchName(`a${String.fromCharCode(9)}b`)).not.toBeNull();
    expect(validateBranchName(`a${String.fromCharCode(0)}b`)).not.toBeNull();
  });
});
