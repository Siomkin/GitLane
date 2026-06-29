import { afterEach, describe, expect, it, vi } from "vitest";
import { isOpenableUrl, openExternalUrl } from "./openExternal";

// Outside the Tauri webview the helper falls back to window.open; pin isTauri so
// the branch under test doesn't depend on the jsdom user-agent.
vi.mock("./platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform")>()),
  isTauri: false,
}));

describe("isOpenableUrl", () => {
  it("allows http, https, and mailto", () => {
    expect(isOpenableUrl("https://github.com/owner/repo")).toBe(true);
    expect(isOpenableUrl("http://localhost:1420")).toBe(true);
    expect(isOpenableUrl("mailto:dev@example.com")).toBe(true);
  });

  it("refuses script, file, data, and malformed URLs", () => {
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl("file:///etc/passwd")).toBe(false);
    expect(isOpenableUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isOpenableUrl("not a url")).toBe(false);
    expect(isOpenableUrl("")).toBe(false);
  });

  it("refuses relative and protocol-relative URLs (no host base to resolve)", () => {
    // A protocol-relative `//evil.com` link in untrusted PR markdown must not open;
    // these have no scheme, so `new URL` without a base rejects them outright.
    expect(isOpenableUrl("/foo")).toBe(false);
    expect(isOpenableUrl("//evil.com/path")).toBe(false);
    expect(isOpenableUrl("../up")).toBe(false);
  });
});

describe("openExternalUrl (plain browser)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens an allowed URL via window.open with noopener and reports success", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(openExternalUrl("https://github.com/owner/repo")).toBe(true);
    expect(open).toHaveBeenCalledWith("https://github.com/owner/repo", "_blank", "noopener");
  });

  it("refuses a disallowed scheme without opening anything", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(openExternalUrl("javascript:alert(1)")).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
