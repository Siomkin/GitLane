import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CommitNode } from "@/lib/api";
import { useUi } from "@/store/ui";
import { identityColor } from "@/lib/identityColor";
import { NodeHoverCard } from "./NodeHoverCard";

function hover() {
  fireEvent.mouseEnter(screen.getByTestId("node-hover-target"));
}

// The graph column is wide enough here that the node (lane 1) is inside it.
const WIDE_COL = 210;

afterEach(() => {
  useUi.setState({ identityColors: {} });
});

function commit(overrides: Partial<CommitNode> = {}): CommitNode {
  return {
    id: "abc123",
    shortId: "abc123",
    summary: "Fix things",
    body: "",
    authorName: "Marta Kowalska",
    authorEmail: "marta@example.com",
    timestamp: 1_752_000_000,
    parents: ["def456"],
    lane: 1,
    row: 3,
    refs: [],
    ...overrides,
  };
}

describe("NodeHoverCard", () => {
  it("shows the author name and full email in the hover card on hover", () => {
    render(<NodeHoverCard commit={commit({ authorEmail: "marta.kowalska@e-medicus.ch" })} graphColW={WIDE_COL} />);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    hover();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByText("Marta Kowalska")).toBeInTheDocument();
    // Full email, not truncated with an ellipsis.
    expect(screen.getByText("marta.kowalska@e-medicus.ch")).toBeInTheDocument();
    expect(screen.queryByText(/co-authored/i)).not.toBeInTheDocument();
  });

  it("lists co-authors from trailers", () => {
    render(
      <NodeHoverCard
        commit={commit({
          body: [
            "Co-authored-by: Jonas Deri <jonas@example.com>",
            "Co-authored-by: Claude <noreply@anthropic.com>",
          ].join("\n"),
        })}
        graphColW={WIDE_COL}
      />,
    );
    hover();
    expect(screen.getByText("Co-authored · 2")).toBeInTheDocument();
    expect(screen.getByText("Jonas Deri")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
  });

  it("renders nothing for unknown automation", () => {
    const { container } = render(
      <NodeHoverCard
        commit={commit({ authorName: "github-actions[bot]", authorEmail: "bot@users.noreply.github.com" })}
        graphColW={WIDE_COL}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("is purely informational — no colour picker on the card", () => {
    render(<NodeHoverCard commit={commit({ authorEmail: "marta@example.com" })} graphColW={WIDE_COL} />);
    hover();
    expect(screen.queryByRole("button", { name: /colour/i })).not.toBeInTheDocument();
  });

  it("honours a saved identity-colour override for the author badge", () => {
    useUi.setState({ identityColors: { "marta@example.com": "#abcdef" } });
    render(<NodeHoverCard commit={commit({ authorEmail: "marta@example.com" })} graphColW={WIDE_COL} />);
    hover();
    expect(identityColor("marta@example.com", useUi.getState().identityColors)).toBe("#abcdef");
  });

  it("does not render a hover target when the node sits beyond a narrowed graph column", () => {
    // lane 1 → graphLaneX ≈ 51px; a very narrow column clips the node.
    render(<NodeHoverCard commit={commit()} graphColW={20} />);
    expect(screen.queryByTestId("node-hover-target")).not.toBeInTheDocument();
  });
});
