import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import type { RemoteHost } from "@/lib/api";
import { useRemoteSessions } from "@/store/remoteSessions";
import { useUi } from "@/store/ui";
import { hostProblem, OpenRemoteDialog, pathProblem } from "./OpenRemoteDialog";

const host = () => screen.getByPlaceholderText("devbox or user@server.example");
const path = () => screen.getByPlaceholderText("/home/you/project");
const openButton = () => screen.getByRole("button", { name: /^(Open|Connecting…)$/ });

function raise(onOpen = vi.fn()) {
  useUi.getState().openOpenRemote({ onOpen });
  render(<OpenRemoteDialog />);
  return onOpen;
}

beforeEach(() => {
  useUi.setState({ openRemote: null });
  useRemoteSessions.setState({
    byOrigin: {},
    sshHosts: [],
    loadSshHosts: vi.fn(async () => useRemoteSessions.setState({ sshHosts: ["devbox", "ci"] })),
    connect: vi.fn().mockResolvedValue({ origin: "ssh://devbox", home: "/home/me", git: "git version 2.53.0" }),
  });
});

describe("OpenRemoteDialog", () => {
  it("suggests hosts from the SSH config", async () => {
    raise();
    await waitFor(() => expect(document.querySelectorAll("#open-remote-hosts option")).toHaveLength(2));
  });

  it("refuses a relative or ~ path and an option-like host before connecting", () => {
    raise();
    fireEvent.change(host(), { target: { value: "devbox" } });
    fireEvent.change(path(), { target: { value: "~/app" } });
    expect(screen.getByText(/absolute path on the server/)).toBeInTheDocument();
    expect(openButton()).toBeDisabled();

    fireEvent.change(path(), { target: { value: "app" } });
    expect(openButton()).toBeDisabled();

    fireEvent.change(host(), { target: { value: "-oProxyCommand=x" } });
    fireEvent.change(path(), { target: { value: "/srv/app" } });
    expect(screen.getByText(/host name or SSH config alias/)).toBeInTheDocument();
    expect(useRemoteSessions.getState().connect).not.toHaveBeenCalled();
  });

  it("shows install progress while connecting, then hands the locator over", async () => {
    let finish: (value: RemoteHost) => void = () => {};
    useRemoteSessions.setState({
      connect: vi.fn(() => new Promise<RemoteHost>((resolve) => (finish = resolve))),
    });
    const onOpen = raise();
    fireEvent.change(host(), { target: { value: "devbox" } });
    fireEvent.change(path(), { target: { value: "/srv/app" } });
    fireEvent.click(openButton());

    expect(useRemoteSessions.getState().connect).toHaveBeenCalledWith("ssh://devbox/srv/app");
    act(() =>
      useRemoteSessions.getState().apply({
        origin: "ssh://devbox",
        state: "installing",
        progress: { stage: "uploading", percent: 40 },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Uploading GitLane's agent for devbox… 40%");

    await act(async () => finish({ origin: "ssh://devbox", home: null, git: null }));
    expect(onOpen).toHaveBeenCalledWith("ssh://devbox/srv/app");
    expect(useUi.getState().openRemote).toBeNull();
  });

  it("keeps the dialog open with the reason when the host can't be used", async () => {
    useRemoteSessions.setState({
      connect: vi.fn().mockRejectedValue(new Error("devbox did not accept key-based authentication.")),
    });
    const onOpen = raise();
    fireEvent.change(host(), { target: { value: "devbox" } });
    fireEvent.change(path(), { target: { value: "/srv/app" } });
    fireEvent.click(openButton());

    expect(await screen.findByText("devbox did not accept key-based authentication.")).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
    expect(useUi.getState().openRemote).not.toBeNull();
    expect(openButton()).toBeEnabled();
  });
});

describe("open-remote validation", () => {
  it("accepts aliases, user@host and ports; refuses options and spaces", () => {
    expect(hostProblem("devbox")).toBeNull();
    expect(hostProblem("me@build.example:2222")).toBeNull();
    expect(hostProblem("-p")).not.toBeNull();
    expect(hostProblem("dev box")).not.toBeNull();
  });

  it("needs an absolute server path without ~", () => {
    expect(pathProblem("/srv/app")).toBeNull();
    expect(pathProblem("srv/app")).not.toBeNull();
    expect(pathProblem("~/app")).not.toBeNull();
    expect(pathProblem("/~/app")).not.toBeNull();
  });
});
