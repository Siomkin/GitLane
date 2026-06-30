import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ChangeSummary } from "../../lib/changeSummary";
import { ChangeTypeCounts } from "./ChangeTypeCounts";

const summary = (over: Partial<ChangeSummary> = {}): ChangeSummary => ({
  added: 0,
  modified: 0,
  deleted: 0,
  conflicted: 0,
  ...over,
});

describe("ChangeTypeCounts", () => {
  it("renders nothing when every bucket is zero", () => {
    const { container } = render(<ChangeTypeCounts summary={summary()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only the non-zero bucket for an edit-only tree", () => {
    render(<ChangeTypeCounts summary={summary({ modified: 14 })} />);
    expect(screen.getByTitle("14 modified")).toHaveTextContent("14");
    expect(screen.queryByTitle(/added$/)).toBeNull();
    expect(screen.queryByTitle(/deleted$/)).toBeNull();
    expect(screen.queryByTitle(/conflicted$/)).toBeNull();
  });

  it("shows added, modified, and deleted together, each with a tooltip", () => {
    render(<ChangeTypeCounts summary={summary({ added: 1, modified: 14, deleted: 2 })} />);
    expect(screen.getByTitle("1 added")).toHaveTextContent("1");
    expect(screen.getByTitle("14 modified")).toHaveTextContent("14");
    expect(screen.getByTitle("2 deleted")).toHaveTextContent("2");
    expect(screen.queryByTitle(/conflicted$/)).toBeNull();
  });

  it("surfaces the conflicted bucket when present", () => {
    render(<ChangeTypeCounts summary={summary({ modified: 1, conflicted: 3 })} />);
    expect(screen.getByTitle("3 conflicted")).toHaveTextContent("3");
  });
});
