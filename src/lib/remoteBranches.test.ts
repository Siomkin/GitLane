import { describe, expect, it } from "vitest";
import type { BranchInfo } from "./api";
import { remoteTrackingCheckoutCandidate } from "./remoteBranches";

const branch = (over: Partial<BranchInfo>): BranchInfo => ({
  name: "main",
  kind: "local",
  target: null,
  isHead: false,
  upstream: null,
  remote: null,
  ...over,
});

describe("remoteTrackingCheckoutCandidate", () => {
  it("returns the remote and local branch name for a remote-only ref", () => {
    expect(
      remoteTrackingCheckoutCandidate("origin/feature", [
        branch({ name: "origin/feature", kind: "remote", remote: "origin" }),
      ]),
    ).toEqual({ remote: "origin", branch: "feature" });
  });

  it("handles slash-containing remote names by using backend attribution", () => {
    expect(
      remoteTrackingCheckoutCandidate("team/origin/feature/a", [
        branch({ name: "team/origin/feature/a", kind: "remote", remote: "team/origin" }),
      ]),
    ).toEqual({ remote: "team/origin", branch: "feature/a" });
  });

  it("returns the local checkout when the local branch already exists", () => {
    expect(
      remoteTrackingCheckoutCandidate("origin/feature", [
        branch({ name: "feature", kind: "local" }),
        branch({ name: "origin/feature", kind: "remote", remote: "origin" }),
      ]),
    ).toEqual({ remote: "origin", branch: "feature" });
  });
});
