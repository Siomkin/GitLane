import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the plugin seam so the store's mount-time loadVersion()/check() never
// touch the (absent) Tauri runtime. Mocking the `@/lib/updater` alias also
// intercepts the store's `../lib/updater` import — both resolve to one file.
const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  currentVersion: vi.fn(),
  relaunchApp: vi.fn(),
}));
vi.mock("@/lib/updater", () => mocks);

import type { Update } from "@/lib/updater";
import { useUpdates } from "@/store/updates";
import { UpdateSection } from "./UpdateSection";

const handle = { downloadAndInstall: vi.fn() } as unknown as Update;

beforeEach(() => {
  mocks.checkForUpdate.mockResolvedValue(null);
  mocks.currentVersion.mockResolvedValue("0.1.0");
  useUpdates.setState(
    { status: "idle", version: "0.1.0", newVersion: null, notes: null, downloaded: 0, contentLength: null, error: null, update: null },
    false,
  );
});

const btn = () => screen.getByRole("button");

describe("UpdateSection", () => {
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

  it("offers install with version + notes when an update is available", () => {
    useUpdates.setState({ status: "available", newVersion: "0.2.0", notes: "Bug fixes" });
    render(<UpdateSection />);
    expect(btn()).toHaveTextContent("Install update");
    expect(screen.getByText(/Version 0\.2\.0 is ready to install/)).toBeInTheDocument();
    expect(screen.getByText("Bug fixes")).toBeInTheDocument();
  });

  it("shows a percent progress label and no button while downloading", () => {
    useUpdates.setState({ status: "downloading", newVersion: "0.2.0", downloaded: 400, contentLength: 1000 });
    render(<UpdateSection />);
    expect(screen.getByText(/Downloading update/i)).toBeInTheDocument();
    expect(screen.getByText(/40%/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers relaunch once the update is installed", () => {
    useUpdates.setState({ status: "ready", newVersion: "0.2.0" });
    render(<UpdateSection />);
    expect(btn()).toHaveTextContent("Relaunch");
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
