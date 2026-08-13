import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OperationFile } from "@/store/repo";
import { ConflictFileRow } from "./ConflictFileRow";
import type { AiRunState } from "./ai-resolve";

const file: OperationFile = { path: "src/client.py", kind: "text", deletedSide: "", resolved: false };

const renderRow = (aiState?: AiRunState, over: Partial<OperationFile> = {}) =>
  render(
    <ConflictFileRow
      file={{ ...file, ...over }}
      selected={false}
      aiState={aiState}
      oursSub="main (ours)"
      theirsSub="incoming (theirs)"
      onOpen={vi.fn()}
      onAcceptOurs={vi.fn()}
      onAcceptTheirs={vi.fn()}
    />,
  );

describe("ConflictFileRow agent state", () => {
  it("spins the status badge while the agent is on this file", () => {
    const { container } = renderRow("resolving");

    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    // The spinner is decorative, so the state has to reach the row's label.
    expect(screen.getByRole("button", { name: /Open conflict/ })).toHaveAccessibleName(
      /agent resolving this file/,
    );
  });

  it("chips a queued or answered file, since the badge can't show either", () => {
    const queued = renderRow("queued");
    expect(screen.getByText("queued")).toBeInTheDocument();
    queued.unmount();

    renderRow("proposed");
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("shows nothing extra with no run, and never over a staged file", () => {
    const { container, unmount } = renderRow();
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open conflict/ })).toHaveAccessibleName(
      "Open conflict in src/client.py",
    );
    unmount();

    // A resolved file is settled — its check must not be replaced by a chip.
    renderRow("proposed", { resolved: true });
    expect(screen.queryByText("ready")).not.toBeInTheDocument();
  });
});
