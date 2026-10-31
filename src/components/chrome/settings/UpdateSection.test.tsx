import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the plugin seam so the store's mount-time loadVersion()/check() never
// touch the (absent) Tauri runtime. Mocking the `@/lib/updater` alias also
// intercepts the store's `../lib/updater` import — both resolve to one file.
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
import { useUi } from "@/store/ui";
import { useUpdates } from "@/store/updates";
import { UpdateSection } from "./UpdateSection";

const handle = { downloadAndInstall: vi.fn() } as unknown as Update;
// The real actions, restored before each test (one test swaps in spies).
const { check, downloadAndInstall, restart } = useUpdates.getState();

beforeEach(() => {
  mocks.checkForUpdate.mockResolvedValue(null);
  mocks.listReleaseNotes.mockReset();
  mocks.listReleaseNotes.mockResolvedValue({
    releases: [{ version: "0.2.0", publishedAt: null, body: "Bug fixes" }],
    hasMore: false,
  });
  useUi.setState({ skippedUpdateVersion: null });
  mocks.currentVersion.mockResolvedValue("0.1.0");
  useUpdates.setState(
    { supported: true, status: "idle", version: "0.1.0", newVersion: null, releaseNotes: null, downloaded: 0, contentLength: null, error: null, update: null, check, downloadAndInstall, restart },
    false,
  );
});

const btn = () => screen.getByRole("button");

describe("UpdateSection", () => {
  it("identifies source builds without offering the release updater", () => {
    useUpdates.setState({ supported: false });
    render(<UpdateSection />);
    expect(screen.getByText("Source build")).toBeInTheDocument();
    expect(screen.getByText(/pull the latest source and rebuild/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers a check and shows the running version when idle", () => {
    render(<UpdateSection />);
    expect(screen.getByText(/running GitLane 0\.1\.0/)).toBeInTheDocument();
    expect(btn()).toHaveTextContent("Check for updates");
    expect(btn()).toBeEnabled();
  });

  it("confirms the latest version when up to date", () => {
    useUpdates.setState({ status: "upToDate" });
    render(<UpdateSection />);
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
    expect(screen.getByText(/latest version/i)).toBeInTheDocument();
  });

  it("disables the button while checking", () => {
    useUpdates.setState({ status: "checking" });
    render(<UpdateSection />);
    expect(btn()).toHaveTextContent("Checking…");
    expect(btn()).toBeDisabled();
  });

  it("offers install, skip and the release notes when an update is available", async () => {
    useUpdates.setState({ status: "available", newVersion: "0.2.0" });
    render(<UpdateSection />);
    expect(screen.getByRole("button", { name: "Install update" })).toBeInTheDocument();
    expect(screen.getByText(/Version 0\.2\.0 is ready to install/)).toBeInTheDocument();
    expect(await screen.findByText("Bug fixes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Skip this version" }));
    expect(useUi.getState().skippedUpdateVersion).toBe("0.2.0");
  });

  it("wires check, install and relaunch to the store", async () => {
    const check = vi.fn(async () => {});
    const downloadAndInstall = vi.fn(async () => {});
    const restart = vi.fn(async () => {});
    useUpdates.setState({ check, downloadAndInstall, restart });

    const { unmount } = render(<UpdateSection />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(check).toHaveBeenCalledOnce();
    unmount();

    useUpdates.setState({ status: "available", newVersion: "0.2.0", update: handle });
    const second = render(<UpdateSection />);
    fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    second.unmount();

    useUpdates.setState({ status: "ready" });
    render(<UpdateSection />);
    fireEvent.click(screen.getByRole("button", { name: "Relaunch" }));
    expect(restart).toHaveBeenCalledOnce();
  });

  it("collapses and re-expands the What's new list", async () => {
    useUpdates.setState({ status: "available", newVersion: "0.2.0" });
    render(<UpdateSection />);
    const toggle = screen.getByRole("button", { name: "What's new" });
    expect(await screen.findByText("Bug fixes")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Bug fixes")).not.toBeVisible();

    fireEvent.click(toggle);
    expect(screen.getByText("Bug fixes")).toBeVisible();
    // Hidden, not remounted: collapsing never re-requests the notes.
    expect(mocks.listReleaseNotes).toHaveBeenCalledOnce();
  });

  it("labels a skipped version a manual check offered, without a skip button", () => {
    useUi.setState({ skippedUpdateVersion: "0.2.0" });
    useUpdates.setState({ status: "available", newVersion: "0.2.0" });
    render(<UpdateSection />);
    expect(screen.getByText(/you skipped this version/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install update" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip this version" })).toBeNull();
  });

  it("offers a check, not 'up to date', after the launch check skipped silently", async () => {
    useUi.setState({ skippedUpdateVersion: "0.2.0" });
    mocks.checkForUpdate.mockResolvedValue({ version: "0.2.0", close: vi.fn(async () => {}) });
    await useUpdates.getState().check({ quiet: true, launch: true });
    expect(useUpdates.getState().status).toBe("idle");
    render(<UpdateSection />);
    expect(btn()).toHaveTextContent("Check for updates");
    expect(screen.queryByText(/up to date/i)).toBeNull();
  });

  it("shows a percent progress label and no action button while downloading", () => {
    useUpdates.setState({ status: "downloading", newVersion: "0.2.0", downloaded: 400, contentLength: 1000 });
    render(<UpdateSection />);
    expect(screen.getByText(/Downloading update/i)).toBeInTheDocument();
    expect(screen.getByText(/40%/)).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["What's new"]);
  });

  it("offers relaunch once the update is installed", () => {
    useUpdates.setState({ status: "ready", newVersion: "0.2.0" });
    render(<UpdateSection />);
    expect(screen.getByRole("button", { name: "Relaunch" })).toBeInTheDocument();
    expect(screen.getByText(/Restart to finish updating to 0\.2\.0/)).toBeInTheDocument();
  });

  it("offers a retry (keeping the handle) after a failed download", () => {
    useUpdates.setState({ status: "error", error: "network drop", update: handle });
    render(<UpdateSection />);
    expect(btn()).toHaveTextContent("Retry download");
    expect(screen.getByText(/Download failed/)).toBeInTheDocument();
    expect(screen.getByText("network drop")).toBeInTheDocument();
  });

  it("falls back to a plain check when a check (not download) errored", () => {
    useUpdates.setState({ status: "error", error: "offline", update: null });
    render(<UpdateSection />);
    expect(btn()).toHaveTextContent("Check for updates");
    expect(screen.getByText(/Update check failed/)).toBeInTheDocument();
    expect(screen.getByText("offline")).toBeInTheDocument();
  });
});
