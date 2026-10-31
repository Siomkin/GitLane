import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import type { AcpAgent, RepoSummary } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { AgentActionControl } from "./AgentActionControl";

const AGENT: AcpAgent = { id: "a", name: "Agent", command: "agent acp", model: "", config: {} } as AcpAgent;
const summary = (path: string): RepoSummary => ({
  path,
  workdir: path,
  headBranch: "main",
  headOid: null,
  detached: false,
  unborn: false,
  isWorktree: false,
});

const renderControl = () =>
  render(
    <AgentActionControl
      agents={[AGENT]}
      activeAgentId="a"
      label="Draft"
      buttonAriaLabel="Draft with an agent"
      menuLabel="Draft with"
      disabled={false}
      disabledTitle="unused"
      onPick={() => {}}
    />,
  );

describe("AgentActionControl", () => {
  beforeEach(() => useRepo.setState({ summary: summary("/repo") }));

  it("is usable for a local repository", () => {
    renderControl();
    expect(screen.getByRole("button", { name: "Draft with an agent" })).toBeEnabled();
  });

  it("is off for a repository opened over SSH, saying why", () => {
    useRepo.setState({ summary: summary("ssh://devbox/srv/app") });
    renderControl();
    const button = screen.getByRole("button", { name: "Draft with an agent" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Unavailable for remote repositories");
  });
});
