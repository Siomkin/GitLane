import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RemoteHost, SshConnection } from "@/lib/api";
import { useRemoteSessions } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { OpenRemoteDialog } from "./OpenRemoteDialog";

const WORK: SshConnection = { name: "Work laptop", host: "build.example", user: "me", port: null, identityFile: "~/.ssh/work" };

function raise(onOpen = vi.fn()) {
  useUi.getState().openOpenRemote({ onOpen });
  render(<OpenRemoteDialog />);
  return onOpen;
}

const hosts = () => screen.getByRole("list", { name: "Hosts" });

beforeEach(() => {
  invokeMock.mockReset();
  // The browser lists `/home/me` over the remote session.
  invokeMock.mockImplementation(async (cmd: string, args: { command?: string; args?: { path?: string } }) =>
    cmd === "remote_invoke" && args.command === "list_directory" && args.args?.path === "ssh://me@build.example/home/me"
      ? [
          { name: "app", isRepo: true, readable: true },
          { name: "secret", isRepo: false, readable: false },
        ]
      : [],
  );
  useUi.setState({ openRemote: null });
  useRepo.setState({ openPaths: [] });
  useRemoteSessions.setState({
    byOrigin: {},
    sshHosts: [],
    connections: [],
    loadSshHosts: vi.fn(async () => useRemoteSessions.setState({ sshHosts: ["devbox", "build.example"] })),
    loadConnections: vi.fn(async () => useRemoteSessions.setState({ connections: [WORK] })),
    saveConnection: vi.fn(async (_prev, c: SshConnection) => useRemoteSessions.setState({ connections: [c] })),
    connect: vi.fn().mockResolvedValue({ origin: "ssh://me@build.example", home: "/home/me", git: "git version 2.53.0" }),
    testConnection: vi.fn().mockResolvedValue({ origin: "ssh://me@devbox", home: "/home/me", git: "git version 2.53.0" }),
    releaseUnused: vi.fn().mockResolvedValue(undefined),
  });
});

describe("OpenRemoteDialog", () => {
  it("offers saved connections, SSH config hosts and adding one", async () => {
    raise();
    await waitFor(() => expect(within(hosts()).getByText("Work laptop")).toBeInTheDocument());
    expect(within(hosts()).getByText("me@build.example · ~/.ssh/work")).toBeInTheDocument();
    expect(within(hosts()).getByText("devbox")).toBeInTheDocument();
    expect(within(hosts()).getByRole("button", { name: /Add SSH connection/ })).toBeInTheDocument();
  });

  it("connects to a saved connection with progress, browses from home, and opens a marked repository", async () => {
    let finish: (value: RemoteHost) => void = () => {};
    useRemoteSessions.setState({ connect: vi.fn(() => new Promise<RemoteHost>((resolve) => (finish = resolve))) });
    const onOpen = raise();
    fireEvent.click(await within(hosts()).findByText("Work laptop"));

    expect(useRemoteSessions.getState().connect).toHaveBeenCalledWith("ssh://me@build.example/");
    act(() =>
      useRemoteSessions.getState().apply({
        origin: "ssh://me@build.example",
        state: "installing",
        progress: { stage: "uploading", percent: 40 },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Uploading GitLane's helper for Work laptop… 40%");

    await act(async () => finish({ origin: "ssh://me@build.example", home: "/home/me", git: null }));
    const folders = await screen.findByRole("list", { name: "Folders" });
    expect(within(folders).getByRole("button", { name: /secret/ })).toBeDisabled();
    fireEvent.click(within(folders).getByRole("button", { name: /app/ }));
    expect(onOpen).toHaveBeenCalledWith("ssh://me@build.example/home/me/app");
    expect(useRemoteSessions.getState().releaseUnused).not.toHaveBeenCalled();
  });

  it("closing while browsing ends a session nothing else uses", async () => {
    raise();
    fireEvent.click(await within(hosts()).findByText("Work laptop"));
    await screen.findByRole("list", { name: "Folders" });
    fireEvent.click(screen.getByRole("button", { name: "Change host" }));
    expect(useRemoteSessions.getState().releaseUnused).toHaveBeenCalledWith("ssh://me@build.example", []);
  });

  it("adds a connection: test uses the form's key and saves nothing, save connects", async () => {
    raise();
    fireEvent.click(await within(hosts()).findByRole("button", { name: /Add SSH connection/ }));
    fireEvent.change(screen.getByPlaceholderText("Work laptop"), { target: { value: "Devbox" } });
    fireEvent.change(screen.getByPlaceholderText("user@hostname"), { target: { value: "me@devbox" } });
    fireEvent.change(screen.getByPlaceholderText("~/.ssh/server_key"), { target: { value: "~/.ssh/dev" } });

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected · git version 2.53.0")).toBeInTheDocument();
    expect(useRemoteSessions.getState().testConnection).toHaveBeenCalledWith("ssh://me@devbox/", "~/.ssh/dev");
    expect(useRemoteSessions.getState().connect).not.toHaveBeenCalled();
    expect(useRemoteSessions.getState().saveConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Add SSH connection" }));
    await waitFor(() =>
      expect(useRemoteSessions.getState().saveConnection).toHaveBeenCalledWith(null, {
        name: "Devbox",
        host: "devbox",
        user: "me",
        port: null,
        identityFile: "~/.ssh/dev",
      }),
    );
    await waitFor(() => expect(useRemoteSessions.getState().connect).toHaveBeenLastCalledWith("ssh://me@devbox/"));
  });

  it("opens the folder being browsed, and cancelling the add form returns to the picker", async () => {
    const onOpen = raise();
    fireEvent.click(await within(hosts()).findByRole("button", { name: /Add SSH connection/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await within(hosts()).findByText("Work laptop"));
    await screen.findByRole("list", { name: "Folders" });
    fireEvent.click(screen.getByRole("button", { name: "Open this folder" }));
    expect(onOpen).toHaveBeenCalledWith("ssh://me@build.example/home/me");
  });

  it("shows why a test failed", async () => {
    useRemoteSessions.setState({ testConnection: vi.fn().mockRejectedValue(new Error("There is no key file at ~/.ssh/x.")) });
    raise();
    fireEvent.click(await within(hosts()).findByRole("button", { name: /Add SSH connection/ }));
    fireEvent.change(screen.getByPlaceholderText("user@hostname"), { target: { value: "devbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("There is no key file at ~/.ssh/x.")).toBeInTheDocument();
  });

  it("ends the session when the dialog closes while it is still connecting", async () => {
    let finish: (value: RemoteHost) => void = () => {};
    useRemoteSessions.setState({ connect: vi.fn(() => new Promise<RemoteHost>((resolve) => (finish = resolve))) });
    raise();
    fireEvent.click(await within(hosts()).findByText("Work laptop"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useUi.getState().openRemote).toBeNull();
    await act(async () => finish({ origin: "ssh://me@build.example", home: "/home/me", git: null }));
    expect(useRemoteSessions.getState().releaseUnused).toHaveBeenCalledWith("ssh://me@build.example", []);
  });

  it("keeps the picker open with the reason when the host can't be used", async () => {
    useRemoteSessions.setState({ connect: vi.fn().mockRejectedValue(new Error("devbox didn't accept the sign-in.")) });
    const onOpen = raise();
    fireEvent.click(await within(hosts()).findByText("devbox"));
    expect(await screen.findByText("devbox didn't accept the sign-in.")).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
    expect(hosts()).toBeInTheDocument();
  });
});
