import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the plugin seam so the store is exercised without the Tauri runtime.
const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  currentVersion: vi.fn(),
  relaunchApp: vi.fn(),
  updatesSupported: true,
}));
vi.mock("@/lib/updater", () => mocks);

import type { Update } from "@/lib/updater";
import { useUi } from "./ui";
import { useNotifications } from "./notifications";
import { useUpdates, hasPendingUpdate } from "./updates";

const INITIAL = useUpdates.getState();

/** A minimal fake of the plugin's Update handle — only the method the store calls. */
function fakeUpdate(over: Partial<Pick<Update, "downloadAndInstall">> = {}): Update {
  return { downloadAndInstall: vi.fn(), ...over } as unknown as Update;
}

beforeEach(() => {
  mocks.checkForUpdate.mockReset();
  mocks.currentVersion.mockReset();
  mocks.relaunchApp.mockReset();
  useUi.setState({ lastUpdateCheckAt: 0, autoCheckUpdates: true });
  useNotifications.setState({ toasts: [] });
  useUpdates.setState(
    { supported: true, status: "idle", version: "", newVersion: null, notes: null, downloaded: 0, contentLength: null, error: null, update: null },
    false,
  );
});

describe("useUpdates", () => {
  it("loads the running version for display", async () => {
    mocks.currentVersion.mockResolvedValue("0.1.0");
    await INITIAL.loadVersion();
    expect(useUpdates.getState().version).toBe("0.1.0");
  });

  it("settles to upToDate when no update is offered", async () => {
    mocks.checkForUpdate.mockResolvedValue(null);
    await INITIAL.check({ quiet: true });
    const s = useUpdates.getState();
    expect(s.status).toBe("upToDate");
    expect(hasPendingUpdate(s)).toBe(false);
  });

  it("captures the offered update and lights the indicator", async () => {
    mocks.checkForUpdate.mockResolvedValue({ version: "0.2.0", body: "Bug fixes" });
    await INITIAL.check({ quiet: true });
    const s = useUpdates.getState();
    expect(s.status).toBe("available");
    expect(s.newVersion).toBe("0.2.0");
    expect(s.notes).toBe("Bug fixes");
    expect(hasPendingUpdate(s)).toBe(true);
  });

  it("records the error and surfaces it on a failed check", async () => {
    mocks.checkForUpdate.mockRejectedValue(new Error("offline"));
    await INITIAL.check({ quiet: true });
    const s = useUpdates.getState();
    expect(s.status).toBe("error");
    expect(s.error).toBe("offline");
  });

  it("passes the beta-channel pref (GL-154) through to the updater check", async () => {
    mocks.checkForUpdate.mockResolvedValue(null);

    useUi.setState({ betaUpdates: true });
    await INITIAL.check({ quiet: true });
    expect(mocks.checkForUpdate).toHaveBeenLastCalledWith(true);

    useUpdates.setState({ status: "idle" });
    useUi.setState({ betaUpdates: false });
    await INITIAL.check({ quiet: true });
    expect(mocks.checkForUpdate).toHaveBeenLastCalledWith(false);
  });

  it("stamps the daily throttle only on an up-to-date result, never on failure", async () => {
    // An up-to-date result stamps lastUpdateCheckAt so checkOnLaunch throttles the next check…
    mocks.checkForUpdate.mockResolvedValue(null);
    await INITIAL.check({ quiet: true });
    expect(useUi.getState().lastUpdateCheckAt).toBeGreaterThan(0);

    // …but a failed (e.g. offline) check must NOT stamp it, so the next launch
    // retries instead of being suppressed for 24h.
    useUi.setState({ lastUpdateCheckAt: 0 });
    useUpdates.setState({ status: "idle" });
    mocks.checkForUpdate.mockRejectedValue(new Error("offline"));
    await INITIAL.check({ quiet: true });
    expect(useUi.getState().lastUpdateCheckAt).toBe(0);
  });

  it("does NOT stamp the throttle when an update is available (relaunch re-surfaces it)", async () => {
    // The pending-update state isn't persisted, so the daily throttle must stay
    // unstamped while an update is offered — otherwise a quit-before-install
    // leaves the indicator dark for 24h (no auto re-check). codex P2.
    mocks.checkForUpdate.mockResolvedValue({ version: "0.2.0", body: "x" });
    await INITIAL.check({ quiet: true });
    expect(useUpdates.getState().status).toBe("available");
    expect(useUi.getState().lastUpdateCheckAt).toBe(0);
  });

  it("checkOnLaunch loads the version and runs a quiet check when the throttle allows", async () => {
    mocks.currentVersion.mockResolvedValue("0.1.0");
    mocks.checkForUpdate.mockResolvedValue(null);
    useUi.setState({ autoCheckUpdates: true, lastUpdateCheckAt: 0 });

    await INITIAL.checkOnLaunch();

    expect(useUpdates.getState().version).toBe("0.1.0");
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
    // Quiet: an up-to-date launch check never toasts.
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("checkOnLaunch skips the check within the daily throttle window but still loads the version", async () => {
    mocks.currentVersion.mockResolvedValue("0.1.0");
    useUi.setState({ autoCheckUpdates: true, lastUpdateCheckAt: Date.now() });

    await INITIAL.checkOnLaunch();

    expect(useUpdates.getState().version).toBe("0.1.0");
    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
  });

  it("checkOnLaunch honors the About panel's auto-check toggle", async () => {
    mocks.currentVersion.mockResolvedValue("0.1.0");
    useUi.setState({ autoCheckUpdates: false, lastUpdateCheckAt: 0 });

    await INITIAL.checkOnLaunch();

    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
  });

  it("loads the version but never checks from a source build", async () => {
    mocks.currentVersion.mockResolvedValue("0.1.0");
    useUpdates.setState({ supported: false });

    await INITIAL.checkOnLaunch();
    await INITIAL.check();

    expect(useUpdates.getState().version).toBe("0.1.0");
    expect(useUpdates.getState().status).toBe("idle");
    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
  });

  it("checkOnLaunch re-checks once the last stamp is over a day old", async () => {
    mocks.currentVersion.mockResolvedValue("0.1.0");
    mocks.checkForUpdate.mockResolvedValue(null);
    useUi.setState({ autoCheckUpdates: true, lastUpdateCheckAt: Date.now() - 25 * 60 * 60 * 1000 });

    await INITIAL.checkOnLaunch();

    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("clears a previously-offered handle when a later check fails (no stale retry)", async () => {
    // An update was offered, then a re-check fails: the dead handle must be
    // dropped so the card doesn't offer "Retry download" on it.
    useUpdates.setState({ status: "available", update: fakeUpdate(), newVersion: "0.2.0", notes: "x" });
    mocks.checkForUpdate.mockRejectedValue(new Error("offline"));
    await INITIAL.check({ quiet: true });
    const s = useUpdates.getState();
    expect(s.status).toBe("error");
    expect(s.update).toBeNull();
    expect(s.newVersion).toBeNull();
  });

  it("toasts on a non-quiet up-to-date check but stays silent when quiet", async () => {
    mocks.checkForUpdate.mockResolvedValue(null);
    await INITIAL.check(); // non-quiet
    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toMatch(/up to date/i);

    useNotifications.setState({ toasts: [] });
    useUpdates.setState({ status: "idle" });
    await INITIAL.check({ quiet: true });
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("does not re-check while downloading (re-entrancy guard)", async () => {
    useUpdates.setState({ status: "downloading" });
    await INITIAL.check({ quiet: true });
    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
    expect(useUpdates.getState().status).toBe("downloading");
  });

  it("does not clobber a ready update with a fresh check", async () => {
    useUpdates.setState({ status: "ready", update: fakeUpdate(), newVersion: "0.2.0" });
    await INITIAL.check({ quiet: true });
    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
    expect(useUpdates.getState().status).toBe("ready");
  });

  it("drives download progress through to ready", async () => {
    const downloadAndInstall = vi.fn(async (onEvent: (e: unknown) => void) => {
      onEvent({ event: "Started", data: { contentLength: 1000 } });
      onEvent({ event: "Progress", data: { chunkLength: 400 } });
      onEvent({ event: "Progress", data: { chunkLength: 600 } });
      onEvent({ event: "Finished" });
    });
    useUpdates.setState({ status: "available", update: fakeUpdate({ downloadAndInstall }) });

    await useUpdates.getState().downloadAndInstall();

    const s = useUpdates.getState();
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(s.contentLength).toBe(1000);
    expect(s.downloaded).toBe(1000);
    expect(s.status).toBe("ready");
  });

  it("errors but retains the handle when a download fails (retry path)", async () => {
    const downloadAndInstall = vi.fn(async () => {
      throw new Error("network drop");
    });
    const handle = fakeUpdate({ downloadAndInstall });
    useUpdates.setState({ status: "available", update: handle });

    await useUpdates.getState().downloadAndInstall();

    const s = useUpdates.getState();
    expect(s.status).toBe("error");
    expect(s.error).toBe("network drop");
    expect(s.update).toBe(handle); // kept so UpdateSection can offer a retry
  });

  it("relaunches on restart", async () => {
    mocks.relaunchApp.mockResolvedValue(undefined);
    await INITIAL.restart();
    expect(mocks.relaunchApp).toHaveBeenCalledOnce();
  });

  it("toasts when relaunch fails", async () => {
    mocks.relaunchApp.mockRejectedValue(new Error("relaunch boom"));
    await INITIAL.restart();
    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toMatch(/relaunch boom/i);
  });
});
