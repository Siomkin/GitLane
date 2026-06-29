import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openUrlMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));
// Render as if inside the Tauri webview so external links route through the
// opener plugin (the helper falls back to window.open in a plain browser).
vi.mock("../../../../lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/platform")>()),
  isTauri: true,
}));

import { ForgeKind, type RepoForge } from "@/lib/api";
import { ProviderIndicator } from "./ProviderIndicator";
import type { ProviderState } from "./state";

const GH: RepoForge = {
  hasRemote: true,
  kind: ForgeKind.GitHub,
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/Siomkin/GitLane",
};

const GITLAB: RepoForge = {
  hasRemote: true,
  kind: ForgeKind.GitLab,
  forge: "GitLab",
  host: "gitlab.com",
  webUrl: "https://gitlab.com/siomkin/gitlane",
};

// The "In GitLane" footer renders only while the popover is open, so its
// presence is a reliable open/closed signal now that there's no dialog role.
const popoverOpen = () => screen.queryByText("In GitLane") !== null;

const renderIndicator = (state: ProviderState, forge: RepoForge = GH, prCount = 7) => {
  const onViewPrs = vi.fn();
  const onSignIn = vi.fn();
  const onOpenRepoSettings = vi.fn();
  const onOpen = vi.fn();
  render(
    <ProviderIndicator
      state={state}
      forge={forge}
      prCount={prCount}
      onViewPrs={onViewPrs}
      onSignIn={onSignIn}
      onOpenRepoSettings={onOpenRepoSettings}
      onOpen={onOpen}
    />,
  );
  const toggle = screen.getByRole("button", { name: /remote provider/i });
  return { toggle, onViewPrs, onSignIn, onOpenRepoSettings, onOpen };
};

beforeEach(() => openUrlMock.mockReset());

describe("ProviderIndicator", () => {
  it("opens the popover only after the button is clicked, firing onOpen", () => {
    const { toggle, onOpen } = renderIndicator("connected");
    expect(popoverOpen()).toBe(false);
    fireEvent.click(toggle);
    expect(popoverOpen()).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("dismisses the popover on Escape", () => {
    const { toggle } = renderIndicator("connected");
    fireEvent.click(toggle);
    expect(popoverOpen()).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(popoverOpen()).toBe(false);
  });

  it("connected GitHub: shows the PR count, github + settings shortcuts, and routes the primary to the PRs view", () => {
    const { toggle, onViewPrs } = renderIndicator("connected", GH, 7);
    fireEvent.click(toggle);
    expect(screen.getByText("Pull requests (7)")).toBeInTheDocument();
    expect(screen.getByText("Branches")).toBeInTheDocument();

    fireEvent.click(screen.getByText("View 7 pull requests"));
    expect(onViewPrs).toHaveBeenCalledTimes(1);
    expect(popoverOpen()).toBe(false); // closes after acting
  });

  it("needs-auth: the primary opens the Accounts settings (sign in)", () => {
    const { toggle, onSignIn } = renderIndicator("needs-auth");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText("Sign in to GitHub"));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("connected GitLab: no-PRs shape — open-on-forge primary, no GitHub shortcuts", () => {
    const { toggle } = renderIndicator("connected", GITLAB, 0);
    fireEvent.click(toggle);
    expect(screen.getByText("siomkin/gitlane")).toBeInTheDocument();
    expect(screen.getByText("Open on GitLab")).toBeInTheDocument();
    // No GitHub PR/Issues/settings link rows for a non-GitHub forge.
    expect(screen.queryByText("Issues")).toBeNull();
    expect(screen.queryByText("Branches")).toBeNull();
  });

  it("missing: no PR links, and the primary is the add-remote shortcut", () => {
    const missing: RepoForge = { hasRemote: false, kind: null, forge: null, host: null, webUrl: null };
    const { toggle } = renderIndicator("missing", missing, 0);
    fireEvent.click(toggle);
    expect(screen.getByText("No remote")).toBeInTheDocument();
    expect(screen.queryByText(/Pull requests/)).toBeNull();
    expect(screen.getByText("Add a remote…")).toBeInTheDocument();
  });

  it("error: shows the failure reason and the set-up-gh primary opens the gh CLI page", () => {
    render(
      <ProviderIndicator
        state="error"
        forge={GH}
        prCount={0}
        errorDetail="gh: command not found"
        onViewPrs={vi.fn()}
        onSignIn={vi.fn()}
        onOpenRepoSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /remote provider/i }));
    expect(screen.getByText("gh: command not found")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Set up gh"));
    expect(openUrlMock).toHaveBeenCalledWith("https://cli.github.com");
  });

  it("the hover 'Repo settings' link and footer open the repo settings window", () => {
    const { onOpenRepoSettings } = renderIndicator("connected");
    fireEvent.click(screen.getByText("Repo settings"));
    expect(onOpenRepoSettings).toHaveBeenLastCalledWith("identity");

    fireEvent.click(screen.getByRole("button", { name: /remote provider/i }));
    fireEvent.click(screen.getByText("Repository settings…"));
    expect(onOpenRepoSettings).toHaveBeenLastCalledWith("identity");

    fireEvent.click(screen.getByRole("button", { name: /remote provider/i }));
    fireEvent.click(screen.getByText("Manage remotes…"));
    expect(onOpenRepoSettings).toHaveBeenLastCalledWith("remotes");
  });
});
