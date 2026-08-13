import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiActionId, AiActionScopeKind } from "@/features/agents/ai-actions";
import { useUi } from "@/store/ui";
import { ChangeSummaryCard } from "./ChangeSummaryCard";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

beforeEach(() => {
  useUi.setState({ aiActions: null });
});

describe("ChangeSummaryCard", () => {
  it("opens AI actions on the working tree with short description preselected", () => {
    render(<ChangeSummaryCard />);
    fireEvent.click(screen.getByRole("button", { name: "AI actions" }));
    expect(useUi.getState().aiActions).toEqual({
      kind: AiActionScopeKind.Working,
      action: AiActionId.Short,
    });
  });
});
