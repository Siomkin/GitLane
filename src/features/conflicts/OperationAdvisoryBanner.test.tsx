import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { OperationAdvisoryBanner } from "./OperationAdvisoryBanner";

describe("OperationAdvisoryBanner", () => {
  it("renders nothing when there is no advisory", () => {
    const { container } = render(<OperationAdvisoryBanner advisory="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels a git am (apply-mailbox) state and marks it read-only", () => {
    render(<OperationAdvisoryBanner advisory="apply-mailbox" />);
    expect(screen.getByText("Applying patches (git am)")).toBeInTheDocument();
    expect(screen.getByText(/Continue, skip, or abort it from the terminal/)).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("labels a bisect state", () => {
    render(<OperationAdvisoryBanner advisory="bisect" />);
    expect(screen.getByText("Bisect in progress")).toBeInTheDocument();
    expect(screen.getByText(/Mark commits or end it from the terminal/)).toBeInTheDocument();
  });

  it("acknowledges conflicted files in the copy when present", () => {
    render(<OperationAdvisoryBanner advisory="apply-mailbox" hasConflicts />);
    // The label stays; the detail switches to the conflict-aware guidance.
    expect(screen.getByText("Applying patches (git am)")).toBeInTheDocument();
    expect(screen.getByText(/Conflicted files are listed under Changes/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Continue, skip, or abort it from the terminal/),
    ).not.toBeInTheDocument();
  });
});
