import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useUi } from "@/store/ui";
import { GeneralPanel } from "./GeneralPanel";

beforeEach(() => {
  useUi.setState({ showCommitNodeIcons: true });
});

describe("GeneralPanel commit-node preference", () => {
  it("defaults to icons and persists the classic-dot choice", () => {
    expect(useUi.getInitialState().showCommitNodeIcons).toBe(true);
    render(<GeneralPanel />);
    const toggle = screen.getByRole("switch", { name: "Show commit icons" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);

    expect(useUi.getState().showCommitNodeIcons).toBe(false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    const persisted = JSON.parse(localStorage.getItem("gitlane.ui") ?? "{}") as {
      state?: { showCommitNodeIcons?: boolean };
    };
    expect(persisted.state?.showCommitNodeIcons).toBe(false);
  });
});
