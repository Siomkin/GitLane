import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useAccounts } from "@/store/accounts";
import { useUi } from "@/store/ui";
import { PrAccountZone } from "./PrAccountZone";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useAccounts.setState({ accounts: [], repoAccountId: null });
  useUi.setState({ repoSettingsOpen: true, settingsOpen: false, settingsTab: "general" });
});

describe("PrAccountZone", () => {
  it("'add one in Accounts' closes the repo window and opens global Accounts", () => {
    render(<PrAccountZone />);
    // No account yet → open the picker, which (empty) shows the Accounts CTA.
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    fireEvent.click(screen.getByText(/add one in Accounts/));

    expect(useUi.getState().repoSettingsOpen).toBe(false);
    expect(useUi.getState().settingsOpen).toBe(true);
    expect(useUi.getState().settingsTab).toBe("accounts");
  });
});
