import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openUrlMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));

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

const renderIndicator = (state: ProviderState, forge: RepoForge = GH, prCount = 7) => {
  const onViewPrs = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <ProviderIndicator
      state={state}
      forge={forge}
      prCount={prCount}
      onViewPrs={onViewPrs}
      onOpenSettings={onOpenSettings}
    />,
  );
  const toggle = screen.getByRole("button", { name: /remote provider/i });
  return { toggle, onViewPrs, onOpenSettings };
};

beforeEach(() => openUrlMock.mockReset());

describe("ProviderIndicator", () => {
  it("opens the popover only after the button is clicked", () => {
    const { toggle } = renderIndicator("connected");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("connected GitHub: shows the PR count, github + settings shortcuts, and routes the primary to the PRs view", () => {
    const { toggle, onViewPrs } = renderIndicator("connected", GH, 7);
    fireEvent.click(toggle);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Pull requests (7)")).toBeInTheDocument();
    expect(within(dialog).getByText("Branches")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByText("View 7 pull requests"));
    expect(onViewPrs).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull(); // closes after acting
  });

  it("needs-auth: the primary opens the Accounts settings tab", () => {
    const { toggle, onOpenSettings } = renderIndicator("needs-auth");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText("Sign in to GitHub"));
    expect(onOpenSettings).toHaveBeenCalledWith("accounts");
  });

  it("missing: no PR links, and the primary is the add-remote shortcut", () => {
    const missing: RepoForge = { hasRemote: false, kind: null, forge: null, host: null, webUrl: null };
    const { toggle } = renderIndicator("missing", missing, 0);
    fireEvent.click(toggle);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("No remote")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Pull requests/)).toBeNull();
    expect(within(dialog).getByText("Add a remote…")).toBeInTheDocument();
  });

  it("error: install-gh primary opens the gh CLI page in the browser", () => {
    const { toggle } = renderIndicator("error");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText("Install gh"));
    expect(openUrlMock).toHaveBeenCalledWith("https://cli.github.com");
  });

  it("the hover 'Repo settings' link and footer both open repo settings", () => {
    const { onOpenSettings } = renderIndicator("connected");
    fireEvent.click(screen.getByText("Repo settings"));
    expect(onOpenSettings).toHaveBeenLastCalledWith("repo");

    fireEvent.click(screen.getByRole("button", { name: /remote provider/i }));
    fireEvent.click(screen.getByText("Repository settings…"));
    expect(onOpenSettings).toHaveBeenLastCalledWith("repo");
  });
});
