import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the updater seam so mounting AboutPanel (→ UpdateSection loadVersion /
// the toggle's re-check) never touches the absent Tauri runtime.
const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  currentVersion: vi.fn(),
  relaunchApp: vi.fn(),
}));
vi.mock("@/lib/updater", () => mocks);

import { useUi } from "@/store/ui";
import { useUpdates } from "@/store/updates";
import { AboutPanel } from "./AboutPanel";

beforeEach(() => {
  mocks.checkForUpdate.mockReset();
  mocks.checkForUpdate.mockResolvedValue(null);
  mocks.currentVersion.mockResolvedValue("0.1.0");
  useUpdates.setState(
    { status: "idle", version: "0.1.0", newVersion: null, notes: null, downloaded: 0, contentLength: null, error: null, update: null },
    false,
  );
});

describe("AboutPanel — beta updates toggle (GL-154)", () => {
  it("reflects the betaUpdates pref and toggles it, re-checking on the new channel", () => {
    useUi.setState({ betaUpdates: false });
    render(<AboutPanel />);

    const toggle = screen.getByRole("switch", { name: /Receive beta updates/i });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);

    expect(useUi.getState().betaUpdates).toBe(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    // Switching channel re-checks straight away, on the freshly-selected channel
    // (the store reads the pref one-shot; the set is synchronous).
    expect(mocks.checkForUpdate).toHaveBeenLastCalledWith(true);
  });

  it("locks the beta toggle while a check/download is in flight (no mid-check channel switch)", () => {
    useUi.setState({ betaUpdates: false });
    useUpdates.setState({ status: "checking" });
    render(<AboutPanel />);

    const toggle = screen.getByRole("switch", { name: /Receive beta updates/i });
    expect(toggle).toBeDisabled();

    // A click while disabled must not flip the pref or fire a (no-op) check on
    // the stale channel — the in-flight race the GL-154 review flagged.
    fireEvent.click(toggle);
    expect(useUi.getState().betaUpdates).toBe(false);
    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
  });

  it("keeps the beta and auto-check toggles independent", () => {
    useUi.setState({ betaUpdates: true, autoCheckUpdates: true });
    render(<AboutPanel />);

    fireEvent.click(screen.getByRole("switch", { name: /Receive beta updates/i }));

    expect(useUi.getState().betaUpdates).toBe(false);
    // Toggling the channel must not disturb the daily-check pref.
    expect(useUi.getState().autoCheckUpdates).toBe(true);
  });
});
