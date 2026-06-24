import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the plugin seam so the store is exercised without the Tauri runtime.
const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  currentVersion: vi.fn(),
  relaunchApp: vi.fn(),
}));
vi.mock("../lib/updater", () => mocks);

import type { Update } from "../lib/updater";
import { useUi } from "./ui";
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
  useUi.setState({ toast: null });
  useUpdates.setState(
    { status: "idle", version: "", newVersion: null, notes: null, downloaded: 0, contentLength: null, error: null, update: null },
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

  it("toasts on a non-quiet up-to-date check but stays silent when quiet", async () => {
    mocks.checkForUpdate.mockResolvedValue(null);
    await INITIAL.check(); // non-quiet
    expect(useUi.getState().toast?.message).toMatch(/up to date/i);

    useUi.setState({ toast: null });
    useUpdates.setState({ status: "idle" });
    await INITIAL.check({ quiet: true });
    expect(useUi.getState().toast).toBeNull();
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
    expect(useUi.getState().toast?.message).toMatch(/relaunch boom/i);
  });
});
