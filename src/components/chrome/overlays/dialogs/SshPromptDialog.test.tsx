import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRemoteSessions } from "@/store/remoteSessions";
import { fingerprintOf, SshPromptDialog } from "./SshPromptDialog";

const HOST_KEY = [
  "The authenticity of host 'devbox (10.0.0.2)' can't be established.",
  "ED25519 key fingerprint is SHA256:Abc123+/xyz.",
  "This key is not known by any other names.",
  "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
].join("\n");

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  useRemoteSessions.setState({ prompts: [] });
});

describe("SshPromptDialog", () => {
  it("shows nothing until ssh asks", () => {
    const { container } = render(<SshPromptDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("asks to trust a new host key, showing its fingerprint, and answers yes", () => {
    useRemoteSessions.getState().addPrompt({ id: 1, origin: "ssh://devbox", prompt: HOST_KEY, kind: "hostKey" });
    render(<SshPromptDialog />);
    expect(screen.getByText("Trust devbox?")).toBeInTheDocument();
    expect(screen.getByText("SHA256:Abc123+/xyz")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Trust and connect" }));
    expect(invokeMock).toHaveBeenCalledWith("answer_ssh_prompt", { id: 1, secretAnswer: "yes" });
    expect(useRemoteSessions.getState().prompts).toEqual([]);
  });

  it("takes a password masked, sends it once, and cancel sends nothing", () => {
    const store = useRemoteSessions.getState();
    store.addPrompt({ id: 2, origin: "ssh://me@devbox", prompt: "me@devbox's password: ", kind: "secret" });
    store.addPrompt({ id: 3, origin: "ssh://me@devbox", prompt: "Verification code: ", kind: "secret" });
    render(<SshPromptDialog />);

    const field = screen.getByLabelText(/password/);
    expect(field).toHaveAttribute("type", "password");
    fireEvent.change(field, { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(invokeMock).toHaveBeenCalledWith("answer_ssh_prompt", { id: 2, secretAnswer: "hunter2" });

    // The next question starts empty, and Cancel answers null.
    expect(screen.getByLabelText(/Verification code/)).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(invokeMock).toHaveBeenLastCalledWith("answer_ssh_prompt", { id: 3, secretAnswer: null });
  });

  it("reads the fingerprint out of ssh's question", () => {
    expect(fingerprintOf(HOST_KEY)).toBe("SHA256:Abc123+/xyz");
    expect(fingerprintOf("ED25519 key fingerprint is: SHA256:4SomGSz/lQ8\nThis key")).toBe("SHA256:4SomGSz/lQ8");
    expect(fingerprintOf("password: ")).toBeNull();
  });
});
