// A glab / origin sign-in is what drives the PR surface for those forges, so
// its row must not read "Sign-in only" (2026-09-25 audit A8-4).
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ForgeAuthStatus } from "@/lib/api";
import { ConnectedForgeCard } from "./ConnectedForgeCard";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const status = (over: Partial<ForgeAuthStatus>): ForgeAuthStatus => ({
  provider: "gitlab",
  forge: "GitLab",
  cli: "glab",
  authMethod: "GitLab CLI",
  available: true,
  authenticated: true,
  loginCommand: "glab auth login",
  docsUrl: "https://gitlab.com",
  notes: "",
  ...over,
});

describe("ConnectedForgeCard", () => {
  it("does not label a signed-in glab account sign-in only", () => {
    render(<ConnectedForgeCard status={status({})} />);
    expect(screen.queryByText("Sign-in only")).not.toBeInTheDocument();
  });

  it("still labels a provider whose sign-in does not drive PRs", () => {
    render(
      <ConnectedForgeCard
        status={status({ provider: "azure-devops", forge: "Azure DevOps", cli: "az", authMethod: "Azure CLI" })}
      />,
    );
    expect(screen.getByText("Sign-in only")).toBeInTheDocument();
  });
});
