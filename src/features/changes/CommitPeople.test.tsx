import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommitPeople } from "./CommitPeople";

describe("CommitPeople", () => {
  it("renders nothing without person trailers", () => {
    const { container } = render(<CommitPeople body="Just a body." />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a single person inline with their role", () => {
    render(
      <CommitPeople body={"Notes\n\nCo-authored-by: Marta Kowalska <marta@example.com>"} />,
    );
    expect(screen.getByText("Co-authored-by")).toBeInTheDocument();
    expect(screen.getByText("Marta Kowalska")).toBeInTheDocument();
    expect(screen.getByText("marta@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("collapses several people into an expandable group with roles", async () => {
    const user = userEvent.setup();
    render(
      <CommitPeople
        body={[
          "Co-authored-by: Jonas Deri <jonas@example.com>",
          "Reviewed-by: Jane Doe <jane@example.com>",
          "Signed-off-by: Bob Jones <bob@example.com>",
        ].join("\n")}
      />,
    );

    const toggle = screen.getByRole("button", { name: /people/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Jonas Deri +2")).toBeInTheDocument();
    expect(screen.queryByText("Reviewed-by")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Reviewed-by")).toBeInTheDocument();
    expect(screen.getByText("Signed-off-by")).toBeInTheDocument();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });
});
