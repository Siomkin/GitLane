import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useUi } from "@/store/ui";
import { SettingsModal } from "./SettingsModal";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]); // terminal_agents_get etc.
  useUi.setState({
    settingsOpen: true,
    settingsTab: "general",
    confirm: null,
    prompt: null,
    githubSignin: null,
  });
});

describe("SettingsModal", () => {
  it("renders nothing while closed", () => {
    useUi.setState({ settingsOpen: false });
    const { container } = render(<SettingsModal />);
    expect(container).toBeEmptyDOMElement();
  });

  it("exposes accessible dialog semantics", () => {
    render(<SettingsModal />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // The dialog is labelled by the visible "Settings" title.
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId && document.getElementById(labelId)?.textContent).toBe("Settings");
  });

  it("routes nav clicks to the matching panel and marks the active tab", () => {
    render(<SettingsModal />);
    expect(screen.getByText("Appearance and layout preferences.")).toBeInTheDocument();

    const accountsNav = screen.getByRole("button", { name: "Accounts" });
    fireEvent.click(accountsNav);
    expect(useUi.getState().settingsTab).toBe("accounts");
    expect(accountsNav).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();

    const identitiesNav = screen.getByRole("button", { name: "Identities" });
    fireEvent.click(identitiesNav);
    expect(useUi.getState().settingsTab).toBe("identities");
    expect(identitiesNav).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Manual identities")).toBeInTheDocument();

    // Per-repo Identity is now its own window (RepoSettingsModal), so the global
    // nav only carries GLOBAL tabs — switch to another to confirm routing.
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "About" }));
    expect(useUi.getState().settingsTab).toBe("about");
  });

  it("groups AI Agents, Terminal Agents, and Prompts under AI", () => {
    render(<SettingsModal />);
    const nav = within(screen.getByRole("navigation"));
    expect(nav.getByText("AI")).toBeInTheDocument();
    fireEvent.click(nav.getByRole("button", { name: "Prompts" }));
    expect(useUi.getState().settingsTab).toBe("prompts");
    expect(screen.getByRole("heading", { name: "Prompts" })).toBeInTheDocument();
  });

  it("no longer exposes an Identity tab in the global nav (it moved to repo settings)", () => {
    render(<SettingsModal />);
    expect(within(screen.getByRole("navigation")).queryByRole("button", { name: "Identity" })).toBeNull();
  });

  it("closes on the close button", () => {
    render(<SettingsModal />);
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(useUi.getState().settingsOpen).toBe(false);
  });

  it("closes on Escape", () => {
    render(<SettingsModal />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useUi.getState().settingsOpen).toBe(false);
  });

  it("closes on a backdrop click", () => {
    const { container } = render(<SettingsModal />);
    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(useUi.getState().settingsOpen).toBe(false);
  });

  it("keeps the modal open when a drag started inside the dialog ends on the backdrop", () => {
    const { container } = render(<SettingsModal />);
    const backdrop = container.firstElementChild as HTMLElement;
    // Press inside the panel, release on the backdrop (a text selection dragged
    // out of a field) — the click lands on the common ancestor, not a dismiss.
    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.click(backdrop);
    expect(useUi.getState().settingsOpen).toBe(true);
  });

  it("does not self-dismiss while a confirm overlay is open", () => {
    // A delete/reset confirm renders as an App-level sibling; its Escape and
    // backdrop clicks must not also tear down Settings.
    useUi.setState({ confirm: { title: "Delete agent?", onConfirm: () => {} } });
    const { container } = render(<SettingsModal />);

    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(useUi.getState().settingsOpen).toBe(true);
  });

  it("does not self-dismiss while the GitHub sign-in overlay is open", () => {
    useUi.setState({ githubSignin: { host: "github.com" } });
    const { container } = render(<SettingsModal />);

    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(useUi.getState().settingsOpen).toBe(true);
  });
});
