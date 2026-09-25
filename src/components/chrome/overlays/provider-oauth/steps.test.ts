import { describe, it, expect } from "vitest";

import {
  oauthModeFor,
  oauthStepCount,
  oauthStepIndex,
  oauthStepLabel,
} from "./steps";

describe("provider-oauth steps", () => {
  it("maps providers to their flow", () => {
    expect(oauthModeFor("gitlab")).toBe("device");
    expect(oauthModeFor("bitbucket")).toBe("pkce");
  });

  it("device flow has four rows keyed off its events", () => {
    expect(oauthStepCount("device")).toBe(4);
    expect(oauthStepIndex("device", "device_code")).toBe(1);
    expect(oauthStepIndex("device", "polling")).toBe(2);
    expect(oauthStepIndex("device", "authorized")).toBe(3);
    expect(oauthStepIndex("device", "storing")).toBe(3);
    expect(oauthStepIndex("device", "unknown")).toBe(-1);
  });

  it("pkce flow has three rows keyed off its events", () => {
    expect(oauthStepCount("pkce")).toBe(3);
    expect(oauthStepIndex("pkce", "browser")).toBe(0);
    expect(oauthStepIndex("pkce", "waiting")).toBe(1);
    expect(oauthStepIndex("pkce", "authorized")).toBe(2);
  });

  it("labels phrase for state and name the host", () => {
    expect(oauthStepLabel("device", 1, "gitlab.com", false)).toBe(
      "Opening gitlab.com in your browser",
    );
    expect(oauthStepLabel("device", 1, "gitlab.com", true)).toBe("Opened gitlab.com");
    expect(oauthStepLabel("pkce", 1, "bitbucket.org", false)).toBe("Waiting for authorization…");
  });
});
