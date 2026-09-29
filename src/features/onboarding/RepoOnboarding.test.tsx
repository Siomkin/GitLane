// The onboarding overlay shares the dialogs' Escape stack (AUDIT item 2): one
// Escape in Settings raised over a clone error must close Settings only.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
// The screens are not under test; an unknown screen renders only the chrome.
vi.mock("./flows/useOnboarding", () => ({ useOnboarding: () => ({ screen: "none" }) }));

import { useUi } from "@/store/ui";
import { SettingsModal } from "@/components/chrome/SettingsModal";
import { RepoOnboarding } from "./RepoOnboarding";
import { ONBOARDING_MODE } from "./onboarding";

beforeEach(() => {
  invokeMock.mockReset();
  useUi.setState({ settingsOpen: false });
});

describe("RepoOnboarding overlay Escape", () => {
  it("lets Settings raised over it take Escape first", () => {
    const onClose = vi.fn();
    render(<RepoOnboarding mode={ONBOARDING_MODE.Overlay} onClose={onClose} />);
    useUi.setState({ settingsOpen: true, settingsTab: "accounts" });
    render(<SettingsModal />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUi.getState().settingsOpen).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
