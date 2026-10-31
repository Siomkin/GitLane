import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the plugin seam so the store is exercised without the Tauri runtime.
const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  currentVersion: vi.fn(),
  listReleaseNotes: vi.fn(),
  relaunchApp: vi.fn(),
  updatesSupported: true,
}));
vi.mock("@/lib/updater", () => mocks);

import type { Update } from "@/lib/updater";
import { useUi } from "./ui";
import { useNotifications } from "./notifications";
import { useUpdates, hasPendingUpdate } from "./updates";

const INITIAL = useUpdates.getState();

/** A minimal fake of the plugin's Update handle — only the methods the store calls. */
function fakeUpdate(over: Partial<Pick<Update, "downloadAndInstall" | "close" | "version" | "currentVersion">> = {}): Update {
  return { downloadAndInstall: vi.fn(), close: vi.fn(async () => {}), ...over } as unknown as Update;
}

beforeEach(() => {
  mocks.checkForUpdate.mockReset();
  mocks.currentVersion.mockReset();
  mocks.relaunchApp.mockReset();
  mocks.listReleaseNotes.mockReset();
  useUi.setState({ lastUpdateCheckAt: 0, autoCheckUpdates: true, skippedUpdateVersion: null, whatsNewOpen: false });
  useNotifications.setState({ toasts: [] });
  useUpdates.setState(
    { supported: true, status: "idle", version: "", newVersion: null, releaseNotes: null, downloaded: 0, contentLength: null, error: null, update: null },
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
    useUpdates.setState({ status: "available", update: fakeUpdate(), newVersion: "0.2.0" });
    mocks.checkForUpdate.mockRejectedValue(new Error("offline"));
    await INITIAL.check({ quiet: true });
    const s = useUpdates.getState();
    expect(s.status).toBe("error");
    expect(s.update).toBeNull();
    expect(s.newVersion).toBeNull();
  });

  it("stays silent on a non-quiet up-to-date check (and when quiet)", async () => {
    mocks.checkForUpdate.mockResolvedValue(null);
    await INITIAL.check(); // non-quiet
    expect(useNotifications.getState().toasts).toHaveLength(0);
    expect(useUpdates.getState().status).toBe("upToDate");

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

describe("skipping a version", () => {
  it("keeps the launch check silent about the skipped version and stamps the throttle", async () => {
    useUi.setState({ skippedUpdateVersion: "0.2.0" });
    const handle = fakeUpdate({ version: "0.2.0" });
    mocks.checkForUpdate.mockResolvedValue(handle);

    await INITIAL.check({ quiet: true, launch: true });

    const s = useUpdates.getState();
    expect(s.status).toBe("idle");
    expect(s.update).toBeNull();
    expect(hasPendingUpdate(s)).toBe(false);
    expect(useUi.getState().lastUpdateCheckAt).toBeGreaterThan(0);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("offers a version other than the skipped one", async () => {
    useUi.setState({ skippedUpdateVersion: "0.2.0" });
    mocks.checkForUpdate.mockResolvedValue(fakeUpdate({ version: "0.2.1" }));
    await INITIAL.check({ quiet: true, launch: true });
    expect(useUpdates.getState()).toMatchObject({ status: "available", newVersion: "0.2.1" });
  });

  it("offers the skipped version on a quiet check the user started (channel switch)", async () => {
    useUi.setState({ skippedUpdateVersion: "0.2.0" });
    mocks.checkForUpdate.mockResolvedValue(fakeUpdate({ version: "0.2.0" }));
    await INITIAL.check({ quiet: true });
    expect(useUpdates.getState()).toMatchObject({ status: "available", newVersion: "0.2.0" });
  });

  it("frees the handle a re-check replaces", async () => {
    const old = fakeUpdate({ version: "0.2.0" });
    useUpdates.setState({ status: "available", update: old, newVersion: "0.2.0" });
    mocks.checkForUpdate.mockResolvedValue(fakeUpdate({ version: "0.2.1" }));
    await INITIAL.check();
    expect(old.close).toHaveBeenCalledOnce();

    const kept = useUpdates.getState().update!;
    mocks.checkForUpdate.mockRejectedValue(new Error("offline"));
    await INITIAL.check({ quiet: true });
    expect(kept.close).toHaveBeenCalledOnce();
  });

  it("offers the skipped version on a manual check", async () => {
    useUi.setState({ skippedUpdateVersion: "0.2.0" });
    mocks.checkForUpdate.mockResolvedValue(fakeUpdate({ version: "0.2.0" }));
    await INITIAL.check();
    expect(useUpdates.getState()).toMatchObject({ status: "available", newVersion: "0.2.0" });
  });

  it("skips the offered version, closes the dialog and frees the handle", async () => {
    const handle = fakeUpdate({ version: "0.2.0" });
    useUi.setState({ whatsNewOpen: true });
    useUpdates.setState({ status: "available", update: handle, newVersion: "0.2.0" });

    await useUpdates.getState().skip();

    expect(useUi.getState().skippedUpdateVersion).toBe("0.2.0");
    expect(useUi.getState().whatsNewOpen).toBe(false);
    expect(useUpdates.getState()).toMatchObject({ status: "idle", update: null, newVersion: null });
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each(["downloading", "ready"] as const)("does not skip while %s", async (status) => {
    useUpdates.setState({ status, update: fakeUpdate(), newVersion: "0.2.0" });
    await useUpdates.getState().skip();
    expect(useUi.getState().skippedUpdateVersion).toBeNull();
    expect(useUpdates.getState().status).toBe(status);
  });
});

describe("release notes", () => {
  const NOTES = { releases: [{ version: "0.2.0", publishedAt: null, body: "Fixes" }], hasMore: false };

  beforeEach(() => {
    useUi.setState({ betaUpdates: false });
    useUpdates.setState({
      status: "available",
      update: fakeUpdate({ version: "0.2.0", currentVersion: "0.1.0" }),
      newVersion: "0.2.0",
    });
  });

  it("loads once per offered version", async () => {
    mocks.listReleaseNotes.mockResolvedValue(NOTES);
    await useUpdates.getState().loadReleaseNotes();
    await useUpdates.getState().loadReleaseNotes();
    expect(mocks.listReleaseNotes).toHaveBeenCalledOnce();
    expect(mocks.listReleaseNotes).toHaveBeenCalledWith("0.1.0", "0.2.0", false);
    expect(useUpdates.getState().releaseNotes).toEqual({
      forVersion: "0.2.0",
      from: "0.1.0",
      beta: false,
      state: "loaded",
      data: NOTES,
    });
  });

  it("refetches when the channel changes for the same offered version", async () => {
    mocks.listReleaseNotes.mockResolvedValue(NOTES);
    await useUpdates.getState().loadReleaseNotes();
    useUi.setState({ betaUpdates: true });
    await useUpdates.getState().loadReleaseNotes();
    expect(mocks.listReleaseNotes).toHaveBeenCalledTimes(2);
    expect(mocks.listReleaseNotes).toHaveBeenLastCalledWith("0.1.0", "0.2.0", true);
  });

  it("keeps the update installable and silent when the notes fail", async () => {
    mocks.listReleaseNotes.mockRejectedValue(new Error("offline"));
    await useUpdates.getState().loadReleaseNotes();
    const s = useUpdates.getState();
    expect(s.releaseNotes).toMatchObject({ state: "error" });
    expect(s.status).toBe("available");
    expect(s.error).toBeNull();
    expect(useNotifications.getState().toasts).toHaveLength(0);

    mocks.listReleaseNotes.mockResolvedValue(NOTES);
    await useUpdates.getState().loadReleaseNotes();
    expect(useUpdates.getState().releaseNotes).toMatchObject({ state: "loaded" });
  });

  it("refetches for a newly offered version", async () => {
    mocks.listReleaseNotes.mockResolvedValue(NOTES);
    await useUpdates.getState().loadReleaseNotes();
    useUpdates.setState({ newVersion: "0.3.0" });
    await useUpdates.getState().loadReleaseNotes();
    expect(mocks.listReleaseNotes).toHaveBeenCalledTimes(2);
    expect(mocks.listReleaseNotes).toHaveBeenLastCalledWith("0.1.0", "0.3.0", false);
  });

  it("does nothing without an offered update or a running version", async () => {
    useUpdates.setState({ status: "idle", update: null, newVersion: null, version: "" });
    await useUpdates.getState().loadReleaseNotes();
    expect(mocks.listReleaseNotes).not.toHaveBeenCalled();
  });

  it("loads the running version and earlier ones when nothing is offered", async () => {
    mocks.listReleaseNotes.mockResolvedValue(NOTES);
    useUpdates.setState({ status: "upToDate", update: null, newVersion: null, version: "0.1.0" });
    await useUpdates.getState().loadReleaseNotes();
    expect(mocks.listReleaseNotes).toHaveBeenCalledWith("0.0.0", "0.1.0", false);
    expect(useUpdates.getState().releaseNotes).toMatchObject({ forVersion: "0.1.0", state: "loaded" });
  });
});
