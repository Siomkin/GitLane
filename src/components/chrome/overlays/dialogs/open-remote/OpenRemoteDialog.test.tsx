import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RemoteHost } from "@/lib/api";
import { useRemoteSessions } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { OpenRemoteDialog } from "./OpenRemoteDialog";

const host = () => screen.getByPlaceholderText("devbox or server.example.com");
const connectButton = () => screen.getByRole("button", { name: /^(Connect|Connecting…)$/ });

function raise(onOpen = vi.fn()) {
  useUi.getState().openOpenRemote({ onOpen });
  render(<OpenRemoteDialog />);
  return onOpen;
}

beforeEach(() => {
  invokeMock.mockReset();
  // The browser lists `/home/me` over the remote session.
  invokeMock.mockImplementation(async (cmd: string, args: { command?: string; args?: { path?: string } }) =>
    cmd === "remote_invoke" && args.command === "list_directory" && args.args?.path === "ssh://devbox/home/me"
      ? [
          { name: "app", isRepo: true, readable: true },
          { name: "notes", isRepo: false, readable: true },
          { name: "secret", isRepo: false, readable: false },
        ]
      : [],
  );
  useUi.setState({ openRemote: null });
  useRepo.setState({
    recents: [{ path: "ssh://me@ci.example:2222/srv/x", name: "x", branch: null, lastOpenedAt: 0 }],
  });
  useRemoteSessions.setState({
    byOrigin: {},
    sshHosts: [],
    loadSshHosts: vi.fn(async () => useRemoteSessions.setState({ sshHosts: ["devbox", "ci"] })),
    connect: vi.fn().mockResolvedValue({ origin: "ssh://devbox", home: "/home/me", git: "git version 2.53.0" }),
  });
});

describe("OpenRemoteDialog", () => {
  it("suggests recent and SSH config hosts, and a recent one fills every field", async () => {
    raise();
    const suggested = await screen.findByRole("list", { name: "Suggested hosts" });
    await waitFor(() => expect(within(suggested).getByText("devbox")).toBeInTheDocument());
    fireEvent.click(within(suggested).getByText("me@ci.example:2222"));
    expect(host()).toHaveValue("ci.example");
    expect(screen.getByPlaceholderText("optional")).toHaveValue("me");
    expect(screen.getByPlaceholderText("22")).toHaveValue("2222");
  });

  it("refuses an option-like host before connecting", () => {
    raise();
    fireEvent.change(host(), { target: { value: "-oProxyCommand=x" } });
    expect(screen.getByText(/host name, IP address or SSH config alias/)).toBeInTheDocument();
    expect(connectButton()).toBeDisabled();
    expect(useRemoteSessions.getState().connect).not.toHaveBeenCalled();
  });

  it("connects with progress, browses from home, and opens a marked repository", async () => {
    let finish: (value: RemoteHost) => void = () => {};
    useRemoteSessions.setState({ connect: vi.fn(() => new Promise<RemoteHost>((resolve) => (finish = resolve))) });
    const onOpen = raise();
    fireEvent.change(host(), { target: { value: "devbox" } });
    fireEvent.click(connectButton());

    expect(useRemoteSessions.getState().connect).toHaveBeenCalledWith("ssh://devbox/");
    act(() =>
      useRemoteSessions.getState().apply({
        origin: "ssh://devbox",
        state: "installing",
        progress: { stage: "uploading", percent: 40 },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Uploading GitLane's helper for devbox… 40%");

    await act(async () => finish({ origin: "ssh://devbox", home: "/home/me", git: null }));
    const folders = await screen.findByRole("list", { name: "Folders" });
    expect(within(folders).getByRole("button", { name: /secret/ })).toBeDisabled();
    fireEvent.click(within(folders).getByRole("button", { name: /app/ }));
    expect(onOpen).toHaveBeenCalledWith("ssh://devbox/home/me/app");
    expect(useUi.getState().openRemote).toBeNull();
  });

  it("keeps the dialog open with the reason when the host can't be used", async () => {
    useRemoteSessions.setState({
      connect: vi.fn().mockRejectedValue(new Error("devbox did not accept key-based authentication.")),
    });
    const onOpen = raise();
    fireEvent.change(host(), { target: { value: "devbox" } });
    fireEvent.click(connectButton());

    expect(await screen.findByText("devbox did not accept key-based authentication.")).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
    expect(connectButton()).toBeEnabled();
  });
});
