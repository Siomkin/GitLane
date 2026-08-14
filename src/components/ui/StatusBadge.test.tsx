import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge, StatusPill } from "./StatusBadge";

describe("StatusBadge", () => {
  it("renders the status letter", () => {
    render(<StatusBadge status="M" />);
    expect(screen.getByText("M")).toBeInTheDocument();
  });

  it("applies the modified tone for an 'm' status (case-insensitive)", () => {
    render(<StatusBadge status="m" />);
    expect(screen.getByText("m").className).toContain("amber");
  });

  it("falls back to the neutral tone for an unknown status", () => {
    render(<StatusBadge status="z" />);
    expect(screen.getByText("z").className).toContain("text-neutral-500");
  });
});

describe("StatusPill", () => {
  it("maps the status letter to its word label", () => {
    render(<StatusPill status="d" />);
    expect(screen.getByText("Deleted")).toBeInTheDocument();
  });

  it("shows the raw status when there is no known label", () => {
    render(<StatusPill status="?" />);
    expect(screen.getByText("?")).toBeInTheDocument();
  });
});
