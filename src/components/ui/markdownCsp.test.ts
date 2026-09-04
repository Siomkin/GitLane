import { describe, expect, it } from "vitest";
// eslint-disable-next-line no-restricted-imports -- CSP lives in tauri.conf.json; the @/ alias cannot reach it
import conf from "../../../src-tauri/tauri.conf.json";
import { isTrustedImageHost, isTrustedImageSrc } from "./markdownImages";

function imgSrcDirective(csp: string): string {
  const match = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("img-src "));
  if (!match) throw new Error(`no img-src in CSP: ${csp}`);
  return match.slice("img-src ".length);
}

describe("markdown image policy vs CSP", () => {
  const csp: string = conf.app.security.csp;
  const imgSrc = imgSrcDirective(csp);

  it("does not allow the unused asset: protocol", () => {
    expect(imgSrc.split(/\s+/)).not.toContain("asset:");
    expect(imgSrc).not.toContain("asset.localhost");
  });

  it("allows only GitHub user-content HTTPS hosts, matching isTrustedImageHost", () => {
    const httpsSources = imgSrc.split(/\s+/).filter((token) => token.startsWith("https:"));
    expect(httpsSources).toEqual(["https://*.githubusercontent.com"]);
    expect(isTrustedImageHost("avatars.githubusercontent.com")).toBe(true);
    expect(isTrustedImageHost("raw.githubusercontent.com")).toBe(true);
    expect(isTrustedImageHost("githubusercontent.com")).toBe(true);
    expect(isTrustedImageHost("img.shields.io")).toBe(false);
    expect(isTrustedImageSrc("https://avatars.githubusercontent.com/u/1")).toBe(true);
    expect(isTrustedImageSrc("https://img.shields.io/badge/P2-yellow.svg")).toBe(false);
  });

  it("keeps style-src from opening injected <style> while allowing style attributes", () => {
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).not.toMatch(/style-src 'self' 'unsafe-inline'/);
  });
});
