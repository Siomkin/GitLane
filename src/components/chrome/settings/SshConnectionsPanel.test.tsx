import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { SshConnection } from "@/lib/api";
import { useRemoteSessions } from "@/store/remoteSessions";
import { SshConnectionsPanel } from "./SshConnectionsPanel";

const WORK: SshConnection = { name: "Work laptop", host: "build.example", user: "me", port: 2222, identityFile: "~/.ssh/work" };

beforeEach(() => {
  useRemoteSessions.setState({
    connections: [WORK],
    loadConnections: vi.fn().mockResolvedValue(undefined),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
    saveConnection: vi.fn().mockResolvedValue(undefined),
  });
});

describe("SshConnectionsPanel", () => {
  it("lists saved connections with their address and key, and removes one", () => {
    render(<SshConnectionsPanel />);
    const list = screen.getByRole("list", { name: "SSH connections" });
    expect(within(list).getByText("Work laptop")).toBeInTheDocument();
    expect(within(list).getByText("me@build.example:2222 · ~/.ssh/work")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Work laptop" }));
    expect(useRemoteSessions.getState().deleteConnection).toHaveBeenCalledWith("ssh://me@build.example:2222");
  });

  it("edits a connection in the shared form, replacing it by its origin", async () => {
    render(<SshConnectionsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByPlaceholderText("me@build.example.com")).toHaveValue("me@build.example");
    fireEvent.change(screen.getByPlaceholderText("Build server"), { target: { value: "Build box" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() =>
      expect(useRemoteSessions.getState().saveConnection).toHaveBeenCalledWith("ssh://me@build.example:2222", {
        ...WORK,
        name: "Build box",
      }),
    );
    expect(await screen.findByRole("list", { name: "SSH connections" })).toBeInTheDocument();
  });

  it("starts empty with a way to add one", () => {
    useRemoteSessions.setState({ connections: [] });
    render(<SshConnectionsPanel />);
    expect(screen.getByText("No saved connections yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New SSH connection" }));
    expect(screen.getByText("NEW SSH CONNECTION")).toBeInTheDocument();
  });
});
