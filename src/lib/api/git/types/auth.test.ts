// `GitTransportAuthRef` mirrors the Rust tagged enum: a ref missing its mode's
// required field must fail to compile (checked by `tsc --noEmit`), not reach
// serde at IPC time as an opaque deserialization error.

import { describe, expect, it } from "vitest";
import type { GitTransportAuthRef } from "./auth";

const base = { host: "gitlab.com", credentialHost: "gitlab.com" } as const;

describe("GitTransportAuthRef", () => {
  it("requires each mode's own fields at compile time", () => {
    // @ts-expect-error — a providerToken ref needs its keychain locator.
    const noLocator: GitTransportAuthRef = { ...base, mode: "providerToken", username: "u", provider: "gitlab" };
    // @ts-expect-error — a githubGh ref needs its account ref.
    const noAccount: GitTransportAuthRef = { ...base, mode: "githubGh", username: "u" };
    // @ts-expect-error — a gitlabGlab ref needs its provider.
    const noProvider: GitTransportAuthRef = { ...base, mode: "gitlabGlab" };
    const complete: GitTransportAuthRef = {
      ...base,
      mode: "providerToken",
      username: "oauth2",
      provider: "gitlab",
      providerAccountId: "42",
    };
    expect([noLocator, noAccount, noProvider, complete].map((ref) => ref.mode)).toEqual([
      "providerToken",
      "githubGh",
      "gitlabGlab",
      "providerToken",
    ]);
  });
});
