import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useUi } from "@/store/ui";
import { HistorySearchBar } from "./HistorySearchBar";

beforeEach(() => {
  useUi.setState({ histSearchOpen: false, histQuery: "", histFilter: "all", histFilterOpen: false });
});

// The collapsed toolbar must be exactly the h-12 row + its own divider (48px, to
// match the right panel / review headers); when the filter chips open, the
// divider moves to the chips row so there's still a single bottom border.
describe("HistorySearchBar divider", () => {
  it("puts the bottom border on the h-12 row when the filter chips are closed", () => {
    const { container } = render(<HistorySearchBar countLabel="10 commits" selectedCount={0} />);
    const row = container.querySelector(".h-12")!;
    expect(row.className).toContain("border-b");
    // No second (chips) row exists to carry a divider.
    expect(container.querySelectorAll(".border-b")).toHaveLength(1);
  });

  it("moves the border to the chips row when the filter is open", () => {
    useUi.setState({ histFilterOpen: true });
    const { container } = render(<HistorySearchBar countLabel="10 commits" selectedCount={0} />);
    const row = container.querySelector(".h-12")!;
    expect(row.className).not.toContain("border-b");
    // Exactly one bottom divider overall — now on the chips row.
    expect(container.querySelectorAll(".border-b")).toHaveLength(1);
  });
});
