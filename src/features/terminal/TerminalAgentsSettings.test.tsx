import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { TerminalAgent } from "@/lib/api";
import {
  DEFAULT_COMMIT_AGENT_MESSAGES,
  useCommitAgentMessages,
} from "@/store/commitAgentMessages";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { useNotifications } from "@/store/notifications";
import { TerminalAgentsSettings } from "./TerminalAgentsSettings";

const agent = (over: Partial<TerminalAgent> = {}): TerminalAgent => ({
  id: "claude",
  name: "Claude",
  command: "claude",
  description: "Claude Code",
  enabled: true,
  available: true,
  ...over,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Default backend: terminal_agents_get returns the seeded list; set/reset echo. */
function stubBackend(get: TerminalAgent[] = [agent()]) {
  invokeMock.mockImplementation((command: string) => {
    if (command === "terminal_agents_get") return Promise.resolve(get);
    if (command === "terminal_agents_set") return Promise.resolve();
    if (command === "terminal_agents_reset") return Promise.resolve(get);
    if (command === "terminal_agent_probe") return Promise.resolve(true);
    if (command === "commit_agent_messages_get")
      return Promise.resolve(DEFAULT_COMMIT_AGENT_MESSAGES);
    if (command === "commit_agent_messages_set") return Promise.resolve();
    if (command === "commit_agent_messages_reset")
      return Promise.resolve(DEFAULT_COMMIT_AGENT_MESSAGES);
    return Promise.resolve();
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  useTerminalAgents.setState({ agents: [agent()], loading: false, error: null });
  useCommitAgentMessages.setState({
    messages: DEFAULT_COMMIT_AGENT_MESSAGES,
    loading: false,
    error: null,
  });
  useUi.setState({ confirm: null });
  useNotifications.setState({ toasts: [] });
});

/** Rows render compact by default; click the row's pencil to expand its editor
 *  (which reveals the name/command inputs, Check, and Done). */
async function openEditor(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${name}` }));
}

describe("TerminalAgentsSettings", () => {
  it("uses the full available settings-content width", () => {
    stubBackend();
    const { container } = render(<TerminalAgentsSettings />);

    expect(container.firstElementChild).toHaveClass("w-full");
    expect(container.firstElementChild).not.toHaveClass("max-w-[860px]");
  });

  it("saves commit-agent messages independently from the agent list", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);

    const saveMessages = await screen.findByRole("button", { name: "Save messages" });
    expect(saveMessages).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Draft / improve instruction" }), {
      target: { value: "Summarize the staged changes as a conventional commit." },
    });
    expect(saveMessages).toBeEnabled();
    fireEvent.click(saveMessages);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_agent_messages_set", {
        messages: expect.objectContaining({
          draftInstruction: "Summarize the staged changes as a conventional commit.",
        }),
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("terminal_agents_set", expect.anything());
    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe(
      "Saved commit agent messages",
    );
  });

  it("resets only the draft instruction and waits for Save messages", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "terminal_agents_get") return Promise.resolve([agent()]);
      if (command === "commit_agent_messages_get")
        return Promise.resolve({
          draftInstruction: "Customized draft",
          commitInstruction: "Customized commit",
        });
      if (command === "commit_agent_messages_set") return Promise.resolve();
      return Promise.resolve();
    });
    render(<TerminalAgentsSettings />);

    expect(await screen.findByDisplayValue("Customized draft")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset Draft / improve instruction" }));

    expect(screen.getByDisplayValue(DEFAULT_COMMIT_AGENT_MESSAGES.draftInstruction)).toBeVisible();
    expect(screen.getByDisplayValue("Customized commit")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save messages" })).toBeEnabled();
    expect(invokeMock).not.toHaveBeenCalledWith("commit_agent_messages_reset");

    fireEvent.click(screen.getByRole("button", { name: "Save messages" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_agent_messages_set", {
        messages: {
          draftInstruction: DEFAULT_COMMIT_AGENT_MESSAGES.draftInstruction,
          commitInstruction: "Customized commit",
        },
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("terminal_agents_reset");
  });

  it("resets only the commit instruction", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "terminal_agents_get") return Promise.resolve([agent()]);
      if (command === "commit_agent_messages_get")
        return Promise.resolve({
          draftInstruction: "Customized draft",
          commitInstruction: "Customized commit",
        });
      return Promise.resolve();
    });
    render(<TerminalAgentsSettings />);

    expect(await screen.findByDisplayValue("Customized commit")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reset Commit instruction" }));

    expect(screen.getByDisplayValue("Customized draft")).toBeVisible();
    expect(screen.getByDisplayValue(DEFAULT_COMMIT_AGENT_MESSAGES.commitInstruction)).toBeVisible();
  });

  it("places the terminal panel preview above the agents and commit-agent messages", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);

    const preview = screen.getByText("TERMINAL PANEL PREVIEW");
    const firstAgent = await screen.findByRole("button", { name: "Edit Claude" });
    const messages = screen.getByRole("heading", { name: "Commit agent messages" });
    expect(preview.compareDocumentPosition(firstAgent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(preview.compareDocumentPosition(messages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps Save visible but disabled until the draft changes", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);

    const save = await screen.findByRole("button", { name: "Save agents" });
    expect(save).toBeDisabled();

    await openEditor("Claude");
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Claude Opus" } });

    expect(save).not.toBeDisabled();
  });

  it("ignores a Check result after the command changes", async () => {
    const probe = deferred<boolean>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "terminal_agents_get") return Promise.resolve([agent()]);
      if (command === "terminal_agent_probe") return probe.promise;
      return Promise.resolve();
    });

    render(<TerminalAgentsSettings />);
    await openEditor("Claude");
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    fireEvent.change(screen.getByPlaceholderText("command --flags"), {
      target: { value: "different-agent" },
    });

    await act(async () => {
      probe.resolve(true);
      await probe.promise;
    });

    expect(screen.queryByText("on PATH")).not.toBeInTheDocument();
    expect(screen.getByTitle("Check different-agent to verify PATH availability")).toBeInTheDocument();
  });

  it("adopts a background agent-list change while the draft is pristine", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);
    await screen.findByRole("button", { name: "Edit Claude" });

    // A background source (e.g. the toolbar re-probing) updates the shared store.
    act(() => {
      useTerminalAgents.setState({
        agents: [agent({ id: "codex", name: "Codex", command: "codex" })],
      });
    });

    expect(await screen.findByRole("button", { name: "Edit Codex" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Claude" })).not.toBeInTheDocument();
  });

  it("preserves a dirty draft against a background change", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);
    await openEditor("Claude");
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "My Edit" } });

    act(() => {
      useTerminalAgents.setState({
        agents: [agent({ id: "codex", name: "Codex", command: "codex" })],
      });
    });

    expect(screen.getByDisplayValue("My Edit")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Codex" })).not.toBeInTheDocument();
  });

  it("saves the edited draft and toasts success", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);

    await openEditor("Claude");
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Claude Opus" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save agents" }));

    await waitFor(() =>
      expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe("Saved terminal agents"),
    );
    expect(invokeMock).toHaveBeenCalledWith("terminal_agents_set", expect.anything());
  });

  it("surfaces a save failure as an error toast", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "terminal_agents_get") return Promise.resolve([agent()]);
      if (command === "terminal_agents_set") return Promise.reject(new Error("disk full"));
      return Promise.resolve();
    });
    render(<TerminalAgentsSettings />);

    await openEditor("Claude");
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Edited" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save agents" }));

    await waitFor(() => {
      expect(useNotifications.getState().toasts.slice(-1)[0]?.kind).toBe("error");
      expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toContain("disk full");
    });
  });

  it("reset asks for confirmation, then reloads defaults on confirm", async () => {
    stubBackend([agent({ id: "default", name: "Default", command: "default" })]);
    render(<TerminalAgentsSettings />);

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    const confirm = useUi.getState().confirm;
    expect(confirm?.title).toBe("Reset terminal agents to defaults?");

    await act(async () => {
      confirm!.onConfirm();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe("Reset to default agents"),
    );
    expect(invokeMock).toHaveBeenCalledWith("terminal_agents_reset");
  });

  it("duplicate inserts a copy that opens expanded and marks the draft dirty", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);
    await screen.findByRole("button", { name: "Edit Claude" });

    // The source row starts collapsed, so nothing is in edit mode yet.
    expect(screen.queryByLabelText("Agent name")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Claude" }));

    // The copy lands expanded (one editor open) while the source stays compact.
    expect(screen.getAllByLabelText("Agent name")).toHaveLength(1);
    expect(screen.getByDisplayValue("Claude copy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Claude" })).toBeInTheDocument();
    // The copy is a complete (valid) draft entry, so Save is enabled.
    expect(await screen.findByRole("button", { name: "Save agents" })).not.toBeDisabled();
  });

  it("reset replaces a dirty draft with the defaults", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "terminal_agents_get") return Promise.resolve([agent()]);
      if (command === "terminal_agents_reset")
        return Promise.resolve([agent({ id: "default", name: "Default", command: "default" })]);
      return Promise.resolve();
    });
    render(<TerminalAgentsSettings />);

    await openEditor("Claude");
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Edited Claude" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

    await act(async () => {
      useUi.getState().confirm!.onConfirm();
      await Promise.resolve();
    });

    // Reset collapses everything back to compact rows, so assert by the row's
    // edit affordance rather than an editor input value.
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Default" })).toBeInTheDocument());
    expect(screen.queryByDisplayValue("Edited Claude")).not.toBeInTheDocument();
  });

  it("delete asks for confirmation before dropping the row from the draft", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);
    await screen.findByRole("button", { name: "Edit Claude" });

    fireEvent.click(screen.getByRole("button", { name: "Delete Claude" }));
    const confirm = useUi.getState().confirm;
    expect(confirm?.title).toBe("Delete agent?");

    act(() => confirm!.onConfirm());

    expect(screen.queryByRole("button", { name: "Edit Claude" })).not.toBeInTheDocument();
  });

  it("keeps a visible reason on a collapsed invalid row while Save stays disabled", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);
    await screen.findByRole("button", { name: "Edit Claude" });

    // Add a blank agent — it opens expanded with empty name/command…
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    // …then collapse it back to compact without filling anything in.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    // The collapsed row still explains why the draft can't be saved.
    expect(screen.getByTitle("Name and command are required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save agents" })).toBeDisabled();
  });

  it("reveals compact-row controls on keyboard focus, not just hover", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);

    // The hover-hidden action cluster must also reveal on keyboard focus so
    // tabbing never lands on an invisible, unreachable-looking control.
    const duplicate = await screen.findByRole("button", { name: "Duplicate Claude" });
    expect(duplicate.parentElement!.className).toMatch(/group-focus-within\/row:opacity-100/);
    duplicate.focus();
    expect(duplicate).toHaveFocus();

    // The reorder grip has its own focus fallback.
    const grip = screen.getByRole("button", { name: "Drag Claude to reorder" });
    expect(grip.className).toMatch(/focus-visible:opacity-100/);
  });

  it("ends a drag on pointercancel so a row never sticks in its lifted state", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);
    await screen.findByRole("button", { name: "Edit Claude" });

    const grip = screen.getByRole("button", { name: "Drag Claude to reorder" });
    const card = document.querySelector("[data-agent-card]") as HTMLElement;
    expect(card.style.boxShadow).toBe("");

    // Grab the grip → the row lifts (dragging style applied).
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, isPrimary: true });
    expect(card.style.boxShadow).not.toBe("");

    // An OS gesture / alt-tab cancels the pointer mid-drag — teardown must run
    // even though no `pointerup` ever arrives, so the row settles back down.
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(card.style.boxShadow).toBe("");
  });

  it("ignores window pointer events from a different pointer mid-drag", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);
    const grip = await screen.findByRole("button", { name: "Drag Claude to reorder" });
    const card = document.querySelector("[data-agent-card]") as HTMLElement;

    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, isPrimary: true });
    expect(card.style.boxShadow).not.toBe("");

    // A second (different) pointer's release must NOT end our drag.
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(card.style.boxShadow).not.toBe("");

    // The captured pointer's release ends it.
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(card.style.boxShadow).toBe("");
  });

  it("reorders rows when the captured pointer crosses a row midpoint", async () => {
    stubBackend([agent(), agent({ id: "codex", name: "Codex", command: "codex" })]);
    render(<TerminalAgentsSettings />);
    // Both rows load asynchronously — wait for the second before measuring.
    await screen.findByRole("button", { name: "Drag Codex to reorder" });
    const gripA = screen.getByRole("button", { name: "Drag Claude to reorder" });

    // jsdom has no layout — give the two rows distinct vertical rects so the
    // midpoint math has something to cross.
    const cards = [...document.querySelectorAll("[data-agent-card]")] as HTMLElement[];
    const rectAt = (top: number) =>
      ({ top, bottom: top + 46, height: 46, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
    cards[0].getBoundingClientRect = () => rectAt(0); // Claude
    cards[1].getBoundingClientRect = () => rectAt(46); // Codex

    fireEvent.pointerDown(gripA, { pointerId: 1, button: 0, isPrimary: true });
    // Move below Codex's midpoint (46 + 23) → Claude should land at index 1.
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 80 });

    const orderNow = screen
      .getAllByRole("button", { name: /^Edit / })
      .map((b) => b.getAttribute("aria-label"));
    expect(orderNow).toEqual(["Edit Codex", "Edit Claude"]);
  });

  it("tears down an in-flight drag before starting another (no listener leak)", async () => {
    stubBackend([agent(), agent({ id: "codex", name: "Codex", command: "codex" })]);
    render(<TerminalAgentsSettings />);
    // The second agent loads asynchronously — wait for it before touching either grip.
    const gripB = await screen.findByRole("button", { name: "Drag Codex to reorder" });
    const gripA = screen.getByRole("button", { name: "Drag Claude to reorder" });

    const removeSpy = vi.spyOn(window, "removeEventListener");

    // Start dragging A, then start dragging B before A's pointerup arrives.
    fireEvent.pointerDown(gripA, { pointerId: 1, button: 0, isPrimary: true });
    fireEvent.pointerDown(gripB, { pointerId: 2, button: 0, isPrimary: true });

    // The second start must have detached A's window listeners.
    for (const type of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
      expect(removeSpy).toHaveBeenCalledWith(type, expect.any(Function));
    }
    removeSpy.mockRestore();
  });

  it("does not start a drag on a non-primary pointer (right-click / secondary touch)", async () => {
    stubBackend();
    render(<TerminalAgentsSettings />);
    const grip = await screen.findByRole("button", { name: "Drag Claude to reorder" });
    const card = document.querySelector("[data-agent-card]") as HTMLElement;

    // Right mouse button — must not enter drag state or attach global listeners.
    const addSpy = vi.spyOn(window, "addEventListener");
    fireEvent.pointerDown(grip, { pointerId: 1, button: 2, isPrimary: true });
    expect(card.style.boxShadow).toBe("");
    expect(addSpy).not.toHaveBeenCalledWith("pointermove", expect.any(Function));

    // Secondary (non-primary) touch point — likewise ignored.
    fireEvent.pointerDown(grip, { pointerId: 2, button: 0, isPrimary: false });
    expect(card.style.boxShadow).toBe("");
    addSpy.mockRestore();
  });

  it("does not re-run the FLIP measure on a text edit (only on reorder)", async () => {
    stubBackend();
    const measure = vi.spyOn(Element.prototype, "getBoundingClientRect");
    render(<TerminalAgentsSettings />);
    await openEditor("Claude");

    // The FLIP layout effect is keyed on row order, so typing (which doesn't
    // move any row) must not trigger a re-measure of the cards.
    measure.mockClear();
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Claude Opus" } });
    expect(measure).not.toHaveBeenCalled();

    measure.mockRestore();
  });
});
