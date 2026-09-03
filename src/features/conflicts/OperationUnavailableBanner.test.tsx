import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OperationUnavailableBanner } from "./OperationUnavailableBanner";

describe("OperationUnavailableBanner", () => {
  it("says the operation status couldn't be read and shows the error", () => {
    render(<OperationUnavailableBanner message="git status: exit 128" />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Couldn't read the operation status");
    expect(banner).toHaveTextContent("git status: exit 128");
    expect(banner).toHaveTextContent("Unavailable");
  });
});
