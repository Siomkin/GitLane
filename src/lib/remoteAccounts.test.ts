import { describe, expect, it } from "vitest";

import { pushRemoteForBranch, remoteNameForUpstream } from "./remoteAccounts";

describe("remoteNameForUpstream", () => {
  it("splits on the longest configured remote name (slash-containing remotes)", () => {
    expect(remoteNameForUpstream("origin/x/feature", ["origin", "origin/x"])).toBe("origin/x");
    expect(remoteNameForUpstream("origin/feature", ["origin", "origin/x"])).toBe("origin");
  });

  it("falls back to the first-slash segment for an unlisted remote", () => {
    expect(remoteNameForUpstream("upstream/feature", ["origin"])).toBe("upstream");
  });

  it("returns null when there is no remote/branch split at all", () => {
    expect(remoteNameForUpstream("nonsense", ["origin"])).toBeNull();
    expect(remoteNameForUpstream("/leading", ["origin"])).toBeNull();
  });
});

describe("pushRemoteForBranch", () => {
  it("uses the backend-resolved triangular push remote", () => {
    expect(pushRemoteForBranch({ pushRemote: "fork", upstreamRemote: "origin" })).toBe("fork");
  });

  it("preserves Git's local-repository push target", () => {
    expect(pushRemoteForBranch({ pushRemote: ".", upstreamRemote: "." })).toBe(".");
    expect(pushRemoteForBranch({ upstreamRemote: "." })).toBe(".");
  });

  it("accepts an older payload's configured upstream remote", () => {
    expect(pushRemoteForBranch({ upstreamRemote: "mirror" })).toBe("mirror");
  });

  it("falls back to origin when unset or the branch is unknown (push_target parity)", () => {
    expect(pushRemoteForBranch({ upstreamRemote: null })).toBe("origin");
    expect(pushRemoteForBranch(undefined)).toBe("origin");
  });
});
