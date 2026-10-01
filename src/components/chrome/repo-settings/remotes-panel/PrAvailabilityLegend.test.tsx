// The legend is derived from the PR-capable provider set, so it cannot tell a
// Bitbucket user that PR features are unavailable while the row above says
// "PRs on" (2026-09-25 audit A8-3).
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrAvailabilityLegend } from "./PrAvailabilityLegend";

describe("PrAvailabilityLegend", () => {
  it("lists Bitbucket and Cursor Origin as PR-capable", () => {
    render(<PrAvailabilityLegend />);

    for (const label of ["Bitbucket", "Cursor Origin"]) {
      const row = screen.getByText(label).parentElement;
      expect(row).toHaveTextContent(/pull requests are available/);
    }
    expect(screen.getByText("GitLab").parentElement).toHaveTextContent(/merge requests are available/);
  });
});
