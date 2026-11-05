import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RemoteInfo, RepoSummary } from "@/lib/api";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { useAccounts } from "@/store/accounts";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { GithubConnect } from "./GithubConnect";

const path = "repo-under-test";
const summary: RepoSummary = { path, workdir: path, headBranch: "main", headOid: "abc", detached: false, unborn: false, isWorktree: false };
const remote = (url: string): RemoteInfo => ({ name: "origin", fetchUrl: url, pushUrl: url, isDefault: true });
const origin = remote("https://Siomkin@github.com/Siomkin/GitLane.git");

let open: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  useRepo.setState({ summary, remotes: [origin] });
  useAccounts.setState({ accounts: [], providerTokens: {}, forgeAuth: [], accountsError: null, repoBindingKey: null });
  useUi.setState({ confirm: null, githubSignin: null });
  open = vi.spyOn(window, "open").mockReturnValue(null);
});

afterEach(() => open.mockRestore());

const choose = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
const opened = () => open.mock.calls.map((call: unknown[]) => call[0]);

describe("GithubConnect", () => {
  it("opens on GitHub CLI and shows only the chosen method's fields", () => {
    render(<GithubConnect refresh={null} />);

    expect(screen.getByRole("radio", { name: "GitHub CLI" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Prefer the terminal?")).toBeInTheDocument();
    expect(screen.queryByLabelText("Personal access token")).toBeNull();

    // Three methods only: the token's two storages are one tab.
    expect(screen.queryByRole("radio", { name: "Personal access token" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Git Credential Manager" })).toBeNull();

    choose("Access token");
    expect(screen.getByRole("radio", { name: /GitLane, in your system keychain/ })).toBeChecked();
    expect(screen.getByLabelText("GitHub username")).toBeInTheDocument();
    expect(screen.getByText("GitLane (keychain)")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("HTTPS username")).toBeNull();
    expect(screen.queryByText(/Add an SSH key on GitHub/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /My Git credential helper/ }));
    expect(screen.getByPlaceholderText("HTTPS username")).toBeInTheDocument();
    expect(screen.queryByLabelText("GitHub username")).toBeNull();
    expect(screen.getByText("Your helper")).toBeInTheDocument();
    expect(screen.queryByText("GitLane (keychain)")).toBeNull();

    choose("SSH key");
    expect(screen.getByRole("button", { name: /Add an SSH key on GitHub/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Personal access token")).toBeNull();
    expect(screen.queryByPlaceholderText("HTTPS username")).toBeNull();
  });

  it("moves between methods with the arrow keys", () => {
    render(<GithubConnect refresh={null} />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "GitHub CLI" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Access token" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Personal access token")).toBeInTheDocument();
  });

  it("opens from Fix authentication on the token method with no terminal command", () => {
    render(<GithubConnect refresh={null} reason="authFailure" />);

    expect(screen.getByRole("radio", { name: "Access token" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText(/gh auth login/)).toBeNull();
    expect(screen.queryByText("Needed to push")).toBeNull();

    choose("GitHub CLI");
    expect(screen.queryByText("Prefer the terminal?")).toBeNull();
  });

  it("highlights Contents: Read and write for a refused permission", () => {
    render(<GithubConnect refresh={null} reason="permission" />);

    const contents = screen.getByText("Permissions › Contents").parentElement!;
    expect(within(contents).getByText("Needed to push")).toBeInTheDocument();
  });

  it("suggests token settings without naming the open repository or its owner", () => {
    render(<GithubConnect refresh={null} reason="authFailure" />);

    expect(screen.getByText(/Suggestions, not requirements/)).toBeInTheDocument();
    for (const setting of ["Resource owner", "Repository access", "Permissions › Contents", "Scope"]) {
      expect(screen.getByText(setting)).toBeInTheDocument();
    }
    expect(screen.getByText("repo")).toBeInTheDocument();
    // The repository's names stay off screen (screenshots, screen shares).
    expect(screen.queryByText(/Siomkin\/GitLane/)).toBeNull();
    expect(screen.queryByText("Siomkin")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Classic token/ }));
    expect(opened()).toContain("https://github.com/settings/tokens/new?scopes=repo&description=GitLane");
  });

  it("links an Enterprise Server host's own token pages", () => {
    render(<GithubConnect refresh={null} reason="authFailure" />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("GitHub host"), { target: { value: "github.corp.example" } });
    fireEvent.click(screen.getByRole("button", { name: /Fine-grained token/ }));
    expect(opened()).toContain("https://github.corp.example/settings/personal-access-tokens/new");
  });

  it("links a *.github.com remote's own SSH page and address", () => {
    useRepo.setState({ remotes: [remote("https://Siomkin@octo.github.com/Siomkin/GitLane.git")] });
    render(<GithubConnect refresh={null} />);

    choose("SSH key");
    fireEvent.click(screen.getByRole("button", { name: /Add an SSH key on GitHub/ }));
    expect(opened()).toContain("https://octo.github.com/settings/ssh/new");
    expect(screen.getByText("git@octo.github.com:owner/repo.git")).toBeInTheDocument();
    expect(screen.queryByText(/Siomkin\/GitLane/)).toBeNull();
  });

  it("says a saved token was checked for reading only, and what pushing needs", async () => {
    render(<GithubConnect refresh={null} reason="authFailure" />);

    fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "ghp_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    expect(await screen.findByText(/accepted it for reading/)).toBeInTheDocument();
    expect(screen.getByText(/Pushing also needs Contents: Read and write/)).toBeInTheDocument();
  });

  it("asks the helper method for a token, and offers a GitLane token when nothing reached GitHub", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "check_remote_access"
        ? Promise.reject({
            kind: "auth",
            code: "credentialsMissing",
            message: "fatal: could not read Password for 'https://Siomkin@github.com': terminal prompts disabled",
          })
        : cmd === "approve_https_credential"
          ? Promise.resolve({ username: "Siomkin", helper: "osxkeychain" })
          : emptyIpcInvoke(cmd),
    );
    render(<GithubConnect refresh={null} />);
    choose("Access token");
    fireEvent.click(screen.getByRole("radio", { name: /My Git credential helper/ }));

    expect(screen.getByText(/It is not your GitHub password/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("HTTPS username"), { target: { value: "Siomkin" } });
    fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "ghp_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    expect(await screen.findByText(/Git found no saved GitHub credential/)).toBeInTheDocument();
    expect(screen.getByLabelText("Personal access token")).toHaveValue("ghp_new");
    fireEvent.click(screen.getByRole("button", { name: "Use a GitLane token instead" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_provider_token", expect.objectContaining({ provider: "github" })),
    );

    fireEvent.click(screen.getByRole("button", { name: "Git Credential Manager" }));
    fireEvent.click(screen.getByRole("button", { name: "GitHub credential docs" }));
    expect(opened()).toEqual(
      expect.arrayContaining([
        "https://github.com/git-ecosystem/git-credential-manager#git-credential-manager",
        "https://docs.github.com/get-started/git-basics/caching-your-github-credentials-in-git",
      ]),
    );
  });

  it("starts the device sign-in and links the gh install page", () => {
    render(<GithubConnect refresh={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    expect(useUi.getState().githubSignin).toEqual({ host: "github.com" });
    fireEvent.click(screen.getByRole("button", { name: /GitHub CLI isn't installed/ }));
    expect(opened()).toContain("https://cli.github.com");
    expect(screen.getByText("origin")).toBeInTheDocument();
  });

  it("falls back to generic guidance with no GitHub repository open", () => {
    useRepo.setState({ summary: null, remotes: [] });
    render(<GithubConnect refresh={null} reason="authFailure" />);

    expect(screen.getByText(/Any choice that includes those repositories/)).toBeInTheDocument();
    choose("SSH key");
    expect(screen.getByText("git@github.com:owner/repo.git")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /How to make one/ }));
    expect(opened()).toContain("https://docs.github.com/authentication/connecting-to-github-with-ssh");
  });
});
