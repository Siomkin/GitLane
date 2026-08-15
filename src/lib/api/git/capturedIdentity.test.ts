import { describe, expect, it } from "vitest";
import { capturedIdentityArg } from "./capturedIdentity";
import type { RepoIdentity } from "./types";

const card: RepoIdentity = { name: "Ada", email: "ada@example.test" };

describe("capturedIdentityArg", () => {
  it("maps undefined to notCaptured and null to capturedNone", () => {
    expect(capturedIdentityArg(undefined)).toEqual({ mode: "notCaptured" });
    expect(capturedIdentityArg(null)).toEqual({ mode: "capturedNone" });
  });

  it("carries a read card as the card variant", () => {
    expect(capturedIdentityArg(card)).toEqual({ mode: "card", identity: card });
  });
});
