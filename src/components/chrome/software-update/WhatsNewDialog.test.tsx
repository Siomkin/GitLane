import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The updater seam, mocked so the store never reaches the Tauri runtime.
const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  currentVersion: vi.fn(),
  relaunchApp: vi.fn(),
  listReleaseNotes: vi.fn(),
  updatesSupported: true,
  RELEASES_PAGE_URL: "https://github.com/Siomkin/GitLane/releases",
}));
vi.mock("@/lib/updater", () => mocks);

import type { Update } from "@/lib/updater";
import { UpdateIndicator } from "@/components/chrome/UpdateIndicator";
import { useUi } from "@/store/ui";
import { useUpdates } from "@/store/updates";
import { WhatsNewDialog } from "./WhatsNewDialog";

const handle = { downloadAndInstall: vi.fn(), close: vi.fn(async () => {}), currentVersion: "2.4.1" } as unknown as Update;

const NOTES = {
  releases: [
    { version: "2.4.3", publishedAt: "2026-10-22T17:18:25Z", body: "- **Fixed:** agents start" },
    { version: "2.4.2", publishedAt: null, body: null },
  ],
  hasMore: false,
};

beforeEach(() => {
  mocks.listReleaseNotes.mockReset();
  mocks.listReleaseNotes.mockResolvedValue(NOTES);
  useUi.setState({ whatsNewOpen: true, skippedUpdateVersion: null, settingsOpen: false, betaUpdates: false });
  useUpdates.setState(
    { supported: true, status: "available", version: "2.4.1", newVersion: "2.4.3", releaseNotes: null, downloaded: 0, contentLength: null, error: null, update: handle },
    false,
  );
});

const button = (name: string) => screen.getByRole("button", { name });

describe("WhatsNewDialog", () => {
  it("lists every version in the range with its notes and offers install, skip and later", async () => {
    render(<WhatsNewDialog />);
    expect(screen.getByText("GitLane 2.4.1 → 2.4.3")).toBeInTheDocument();
    expect(await screen.findByText("agents start", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("2.4.2")).toBeInTheDocument();
    expect(screen.getByText("No release notes")).toBeInTheDocument();
    expect(mocks.listReleaseNotes).toHaveBeenCalledWith("2.4.1", "2.4.3", false);
    expect(button("Install update")).toBeInTheDocument();
    expect(button("Skip this version")).toBeInTheDocument();
  });

  it("closes on Later and keeps the update pending", () => {
    render(<WhatsNewDialog />);
    fireEvent.click(button("Later"));
    expect(useUi.getState().whatsNewOpen).toBe(false);
    expect(useUpdates.getState().status).toBe("available");
  });

  it("skips the version and closes", async () => {
    render(<WhatsNewDialog />);
    fireEvent.click(button("Skip this version"));
    await vi.waitFor(() => expect(useUi.getState().whatsNewOpen).toBe(false));
    expect(useUi.getState().skippedUpdateVersion).toBe("2.4.3");
  });

  it("offers only Relaunch and Later once installed", () => {
    useUpdates.setState({ status: "ready" });
    render(<WhatsNewDialog />);
    expect(button("Relaunch")).toBeInTheDocument();
    expect(button("Later")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install update" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip this version" })).toBeNull();
  });

  it("still offers install when the notes fail to load", async () => {
    mocks.listReleaseNotes.mockRejectedValue(new Error("offline"));
    render(<WhatsNewDialog />);
    expect(await screen.findByText(/Couldn't load release notes/)).toBeInTheDocument();
    expect(button("View on GitHub")).toBeInTheDocument();
    expect(button("Install update")).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<WhatsNewDialog />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUi.getState().whatsNewOpen).toBe(false);
  });

  it("stays open across a repository switch", () => {
    useUi.getState().onRepoSwitched();
    expect(useUi.getState().whatsNewOpen).toBe(true);
  });
});

describe("UpdateIndicator", () => {
  it("opens the What's new dialog, not Settings", () => {
    useUi.setState({ whatsNewOpen: false });
    render(<UpdateIndicator />);
    fireEvent.click(screen.getByRole("button"));
    expect(useUi.getState().whatsNewOpen).toBe(true);
    expect(useUi.getState().settingsOpen).toBe(false);
  });
});
