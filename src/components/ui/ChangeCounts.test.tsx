import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChangeCounts } from "./ChangeCounts";

describe("ChangeCounts", () => {
  it("shows +add / −del for a text change", () => {
    render(<ChangeCounts add={3} del={1} />);
    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
    expect(screen.queryByText("binary")).not.toBeInTheDocument();
  });

  it("shows a 'binary' tag instead of +0 −0 for a binary change", () => {
    render(<ChangeCounts add={0} del={0} binary />);
    expect(screen.getByText("binary")).toBeInTheDocument();
    expect(screen.queryByText("+0")).not.toBeInTheDocument();
    expect(screen.queryByText("−0")).not.toBeInTheDocument();
  });

  it("marks a bounded addition count as a lower bound", () => {
    render(<ChangeCounts add={512} del={0} addAtLeast />);
    expect(screen.getByText("+≥512")).toHaveAttribute(
      "title",
      "At least 512 added lines; the large-file count was capped",
    );
  });
});
