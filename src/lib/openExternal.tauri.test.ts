import { beforeEach, describe, expect, it, vi } from "vitest";

// The opener plugin is only reached inside the Tauri webview, so pin isTauri here
// to exercise that branch directly; the sibling `openExternal.test.ts` covers the
// scheme validation and the plain-browser `window.open` fallback.
const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("./platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform")>()),
  isTauri: true,
}));

import { openExternalUrl } from "./openExternal";

describe("openExternalUrl (Tauri webview)", () => {
  beforeEach(() => {
    openUrl.mockReset().mockResolvedValue(undefined);
  });

  it("routes allowed URLs through the opener plugin", () => {
    expect(openExternalUrl("https://github.com/owner/repo")).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://github.com/owner/repo");
  });

  it("refuses a disallowed scheme without touching the opener", () => {
    expect(openExternalUrl("javascript:alert(1)")).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("reports an asynchronous opener failure", async () => {
    const error = new Error("No browser is available");
    const onError = vi.fn();
    openUrl.mockRejectedValueOnce(error);

    expect(openExternalUrl("https://cursor.com/codebase/acme/app/pull/7", onError)).toBe(true);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
  });
});
