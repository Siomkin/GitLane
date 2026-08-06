import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommitNode } from "@/lib/api";
import { useUi } from "@/store/ui";
import { HistorySearchBar } from "./HistorySearchBar";

beforeEach(() => {
  useUi.setState({
    histSearchOpen: false,
    histQuery: "",
    histFilter: "all",
    histFilterOpen: false,
    // Escape stands down while an overlay owns it, so leaking one from a prior
    // test would silently disable the Escape cases below.
    confirm: null,
  });
});

const match = {
  id: "c2",
  shortId: "c2",
  summary: "beta feature",
  authorName: "Ann",
} as CommitNode;

// The collapsed toolbar must be exactly the h-12 row + its own divider (48px, to
// match the right panel / review headers); when the filter chips open, the
// divider moves to the chips row so there's still a single bottom border.
describe("HistorySearchBar divider", () => {
  it("puts the bottom border on the h-12 row when the filter chips are closed", () => {
    const { container } = render(<HistorySearchBar countLabel="10 commits" selectedCount={0} matches={null} />);
    const row = container.querySelector(".h-12")!;
    expect(row.className).toContain("border-b");
    // No second (chips) row exists to carry a divider.
    expect(container.querySelectorAll(".border-b")).toHaveLength(1);
  });

  it("moves the border to the chips row when the filter is open", () => {
    useUi.setState({ histFilterOpen: true });
    const { container } = render(<HistorySearchBar countLabel="10 commits" selectedCount={0} matches={null} />);
    const row = container.querySelector(".h-12")!;
    expect(row.className).not.toContain("border-b");
    // Exactly one bottom divider overall — now on the chips row.
    expect(container.querySelectorAll(".border-b")).toHaveLength(1);
  });
});

// While a text query is active the bar shows the matched commits as a
// clickable list, so a hit is one click away instead of a scroll hunt
// through the dimmed graph.
describe("HistorySearchBar quick results panel", () => {
  it("lists the matches while the search is open with a query", () => {
    useUi.setState({ histSearchOpen: true, histQuery: "beta" });
    render(<HistorySearchBar countLabel="1 match" selectedCount={0} matches={[match]} />);
    expect(screen.getByRole("button", { name: /beta feature/ })).toBeInTheDocument();
  });

  it("shows the empty state when the query matches nothing", () => {
    useUi.setState({ histSearchOpen: true, histQuery: "zzz" });
    render(<HistorySearchBar countLabel="0 matches" selectedCount={0} matches={[]} />);
    expect(screen.getByText("No matching commits.")).toBeInTheDocument();
  });

  it("renders no panel without a text query", () => {
    useUi.setState({ histSearchOpen: true, histQuery: "" });
    render(<HistorySearchBar countLabel="10 commits" selectedCount={0} matches={null} />);
    expect(screen.queryByText("No matching commits.")).not.toBeInTheDocument();
  });
});

// Quick search (this graph) and repo-wide search are alternatives — opening
// one closes the other so both surfaces are never up together.
describe("HistorySearchBar — mutually exclusive search modes", () => {
  const quickButton = () => screen.getByRole("button", { name: "Search commits" });
  const advancedButton = () => screen.getByRole("button", { name: "Search entire repository" });

  it("closes the quick search when the repo-wide search opens", () => {
    useUi.setState({ histSearchOpen: true });
    render(<HistorySearchBar countLabel="10 commits" selectedCount={0} matches={null} />);
    expect(quickButton()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(advancedButton());
    expect(advancedButton()).toHaveAttribute("aria-pressed", "true");
    expect(quickButton()).toHaveAttribute("aria-pressed", "false");
  });

  it("closes the repo-wide search when the quick search opens", () => {
    render(<HistorySearchBar countLabel="10 commits" selectedCount={0} matches={null} />);
    fireEvent.click(advancedButton());
    expect(advancedButton()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(quickButton());
    expect(quickButton()).toHaveAttribute("aria-pressed", "true");
    expect(advancedButton()).toHaveAttribute("aria-pressed", "false");
  });
});

// GL-346: keyboard navigation parks focus on the commit list, so Escape has to
// close the search from wherever focus sits — not just from inside the input.
describe("HistorySearchBar Escape", () => {
  it("closes the quick search when focus is elsewhere", () => {
    useUi.setState({ histSearchOpen: true, histQuery: "aaa" });
    render(<HistorySearchBar countLabel="6 matches" selectedCount={0} matches={null} />);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(useUi.getState().histSearchOpen).toBe(false);
    expect(useUi.getState().histQuery).toBe("");
  });

  it("closes it exactly once when the input itself is focused", () => {
    useUi.setState({ histSearchOpen: true, histQuery: "aaa" });
    render(<HistorySearchBar countLabel="6 matches" selectedCount={0} matches={null} />);

    fireEvent.keyDown(screen.getAllByLabelText("Search commits")[0], { key: "Escape" });

    // A second toggle would have reopened it.
    expect(useUi.getState().histSearchOpen).toBe(false);
  });

  it("leaves Escape to an open dialog", () => {
    useUi.setState({ histSearchOpen: true, confirm: { title: "Reset?", onConfirm: () => {} } });
    render(<HistorySearchBar countLabel="6 matches" selectedCount={0} matches={null} />);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(useUi.getState().histSearchOpen).toBe(true);
  });
});

// The bug this replaced: the listener was registered on the bubble phase, and a
// handler between the input and the document stopped the key before it got
// there — Escape fired in capture and never reached the bubble listener.
describe("HistorySearchBar Escape survives a propagation stopper", () => {
  it("closes even when an ancestor stops propagation", () => {
    useUi.setState({ histSearchOpen: true, histQuery: "aaa" });
    render(
      <div onKeyDown={(e) => e.stopPropagation()}>
        <HistorySearchBar countLabel="6 matches" selectedCount={0} matches={null} />
      </div>,
    );

    fireEvent.keyDown(screen.getAllByLabelText("Search commits")[0], { key: "Escape" });

    expect(useUi.getState().histSearchOpen).toBe(false);
  });
});
