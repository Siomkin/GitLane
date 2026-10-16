import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./App", () => ({
  default: () => {
    throw new Error("shell exploded");
  },
}));

import { Root } from "./Root";

describe("Root", () => {
  it("shows a Reload screen instead of a blank window when the app shell throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<Root />);

    expect(screen.getByRole("alert")).toHaveTextContent("GitLane hit an error.");
    expect(screen.getByRole("alert")).toHaveTextContent("shell exploded");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });
});
