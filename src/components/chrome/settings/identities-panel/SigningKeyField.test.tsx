import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { SigningKey } from "@/lib/api";
import { SigningKeyField } from "./SigningKeyField";

const keys: SigningKey[] = [
  { value: "ABCD1234EF567890", label: "Ada <ada@example.com>", format: "openpgp" },
  { value: "/home/ada/.ssh/id_ed25519.pub", label: "ada@laptop · ssh-ed25519", format: "ssh" },
];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) =>
    cmd === "list_signing_keys" ? keys : null,
  );
});

describe("SigningKeyField", () => {
  it("lists discovered keys and reports value + inferred format on pick", async () => {
    const onChange = vi.fn();
    const { container } = render(<SigningKeyField value="" format="openpgp" onChange={onChange} />);
    // Wait for the async key load to populate the select.
    const select = await screen.findByRole("combobox", { name: "Signing key" });
    expect(container.querySelector('optgroup[label="GPG / OpenPGP"]')).not.toBeNull();
    expect(container.querySelector('optgroup[label="SSH"]')).not.toBeNull();
    expect(screen.getByRole("option", { name: "Ada <ada@example.com>" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "ada@laptop · ssh-ed25519" })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "/home/ada/.ssh/id_ed25519.pub" } });
    expect(onChange).toHaveBeenCalledWith("/home/ada/.ssh/id_ed25519.pub", "ssh");
  });

  it("falls back to a manual key field when the user chooses paste", async () => {
    const onChange = vi.fn();
    render(<SigningKeyField value="" format="openpgp" onChange={onChange} />);
    const select = await screen.findByRole("combobox", { name: "Signing key" });
    fireEvent.change(select, { target: { value: "__manual__" } });
    const input = screen.getByPlaceholderText("4A9F2C1B7E… or ~/.ssh/id_ed25519.pub");
    fireEvent.change(input, { target: { value: "DEADBEEF" } });
    expect(onChange).toHaveBeenCalledWith("DEADBEEF", "openpgp");
  });
});
