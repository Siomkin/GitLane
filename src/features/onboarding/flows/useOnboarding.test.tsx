import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// IPC + the dialog/event plugins the hook touches on mount and during relocate.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const openDialogMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialogMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useOnboarding } from "./useOnboarding";
import { useRepo } from "../../../store/repo";
import type { RecentRepo } from "../../../store/repoSession";

const missing: RecentRepo = {
  path: "/old/gone",
  name: "gone",
  branch: null,
  lastOpenedAt: 0,
  missing: true,
};

beforeEach(() => {
  invokeMock.mockReset();
  // recents_status (mount refresh) and any other read resolve benignly.
  invokeMock.mockResolvedValue([]);
  openDialogMock.mockReset();
  localStorage.clear();
  useRepo.setState({ recents: [missing], summary: null });
});

afterEach(() => vi.restoreAllMocks());

describe("openRecent — relocating a missing recent", () => {
  it("keeps the stale entry and stays open when the picked folder is not a repo", async () => {
    openDialogMock.mockResolvedValue("/picked/not-a-repo");
    // The shared Locate… flow probes the pick with the classified open; a
    // non-repo folder rejects, so nothing is opened, migrated, or dropped.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo"
        ? Promise.reject({
            kind: "notARepository",
            message: "The folder at /picked/not-a-repo is not a git repository anymore.",
            path: "/picked/not-a-repo",
          })
        : Promise.resolve([]),
    );
    const loadSpy = vi.spyOn(useRepo.getState(), "loadRepo");
    const onDone = vi.fn();

    const { result } = renderHook(() => useOnboarding(onDone));
    act(() => result.current.openRecent(missing));

    await waitFor(() => expect(openDialogMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    expect(loadSpy).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(useRepo.getState().recents.map((r) => r.path)).toContain("/old/gone");
  });

  it("drops the stale entry and dismisses once a valid repo opens", async () => {
    openDialogMock.mockResolvedValue("/picked/real");
    // The probe open resolves the normalized summary; the follow-up full load
    // is stubbed to publish it as the active repo.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo"
        ? Promise.resolve({
            path: "/picked/real",
            workdir: "/picked/real",
            headBranch: "main",
            headOid: null,
            detached: false,
          })
        : Promise.resolve([]),
    );
    const loadSpy = vi.spyOn(useRepo.getState(), "loadRepo").mockImplementation(async () => {
      useRepo.setState({
        summary: {
          path: "/picked/real",
          workdir: "/picked/real",
          headBranch: "main",
          headOid: null,
          detached: false,
        },
      });
    });
    const onDone = vi.fn();

    const { result } = renderHook(() => useOnboarding(onDone));
    act(() => result.current.openRecent(missing));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(loadSpy).toHaveBeenCalledWith("/picked/real");
    // The shared Locate… flow dropped the dead entry itself.
    expect(useRepo.getState().recents.map((r) => r.path)).not.toContain("/old/gone");
  });
});

describe("openRecent — opening a present recent", () => {
  const present: RecentRepo = { path: "/code/present", name: "present", branch: "main", lastOpenedAt: 0 };

  it("keeps the overlay open when the open fails (no path change)", async () => {
    useRepo.setState({ recents: [present], summary: null });
    // loadRepo fails to open → summary stays null (path unchanged).
    const loadSpy = vi.spyOn(useRepo.getState(), "loadRepo").mockResolvedValue(undefined);
    const onDone = vi.fn();

    const { result } = renderHook(() => useOnboarding(onDone));
    act(() => result.current.openRecent(present));

    await waitFor(() => expect(loadSpy).toHaveBeenCalledWith("/code/present"));
    await act(async () => {
      await Promise.resolve();
    });

    // No path change → not dismissed; the global error bar surfaces the failure.
    expect(onDone).not.toHaveBeenCalled();
  });

  it("dismisses once the repo becomes active", async () => {
    useRepo.setState({ recents: [present], summary: null });
    const loadSpy = vi.spyOn(useRepo.getState(), "loadRepo").mockImplementation(async () => {
      useRepo.setState({
        summary: {
          path: "/code/present",
          workdir: "/code/present",
          headBranch: "main",
          headOid: null,
          detached: false,
        },
      });
    });
    const onDone = vi.fn();

    const { result } = renderHook(() => useOnboarding(onDone));
    act(() => result.current.openRecent(present));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(loadSpy).toHaveBeenCalledWith("/code/present");
  });
});

describe("clone auth status line", () => {
  it("tracks the manual fields: default system copy flips to entered-token", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("https://gitlab.com/group/repo.git"));
    expect(result.current.cloneForm.authPlan.method).toBe("system");
    expect(result.current.cloneForm.authStatus).toMatch(/Git credential helper \/ GCM/);

    act(() => result.current.cloneForm.setPassword("token"));
    expect(result.current.cloneForm.authPlan.method).toBe("enteredToken");
    expect(result.current.cloneForm.authStatus).toBe("Will authenticate with the token you entered.");
  });

  it("says SSH for ssh URLs", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("git@github.com:o/r.git"));
    expect(result.current.cloneForm.authPlan.method).toBe("ssh");
    expect(result.current.cloneForm.authStatus).toMatch(/SSH key/);
  });
});

describe("auth-failure recovery", () => {
  it("lands on a recoverable error, then Retry with the entered token saves it and reruns the clone", async () => {
    let cloneCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "clone_repo") {
        cloneCalls += 1;
        return cloneCalls === 1
          ? Promise.reject(
              "fatal: unable to access 'https://bitbucket.org/w/r.git/': The requested URL returned error: 403",
            )
          : Promise.resolve("/tmp/r");
      }
      if (cmd === "approve_https_credential") return Promise.resolve({ username: "x", helper: "store" });
      if (cmd === "open_repo") {
        return Promise.resolve({ path: "/tmp/r", workdir: "/tmp/r", headBranch: "main", headOid: null, detached: false });
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("https://bitbucket.org/w/r.git"));
    act(() => result.current.cloneRun.start());
    await waitFor(() => expect(result.current.screen).toBe("error"));
    expect(result.current.cloneRecovery.error?.kind).toBe("denied");
    expect(result.current.cloneRecovery.error?.recoverable).toBe(true);

    // The recovery panel binds its inputs to the flow state; the screen's
    // single bottom Retry then reruns the clone with them.
    act(() => result.current.cloneForm.setUsername("x-bitbucket-api-token-auth"));
    act(() => result.current.cloneForm.setPassword("tok"));
    act(() => result.current.cloneRecovery.retry());

    await waitFor(() => expect(result.current.screen).toBe("opened"));
    // Bitbucket is PR-capable, so the token defaults to the keychain (GL-152) —
    // powering transport and pull requests — rather than the git helper.
    expect(invokeMock).toHaveBeenCalledWith(
      "save_provider_token",
      expect.objectContaining({ provider: "bitbucket", host: "bitbucket.org", token: "tok" }),
    );
    expect(cloneCalls).toBe(2);
    // The credential survives in form state for a possible second failure —
    // the URL didn't change, so the reset effect must not clobber it.
    expect(result.current.cloneForm.username).toBe("x-bitbucket-api-token-auth");
  });

  it("retryWithUrl switches transport and reruns the clone over the new URL", async () => {
    const cloneUrls: string[] = [];
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "clone_repo") {
        cloneUrls.push(String(args?.url));
        return cloneUrls.length === 1
          ? Promise.reject("git@github.com: Permission denied (publickey).")
          : Promise.resolve("/tmp/r");
      }
      if (cmd === "open_repo") {
        return Promise.resolve({ path: "/tmp/r", workdir: "/tmp/r", headBranch: "main", headOid: null, detached: false });
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("git@github.com:octo/repo.git"));
    act(() => result.current.cloneRun.start());
    await waitFor(() => expect(result.current.screen).toBe("error"));
    expect(result.current.cloneRecovery.error?.recoverable).toBe(true);

    // A stray username from earlier state must NOT be baked into the switched
    // URL — the switch starts from the new transport's default auth.
    act(() => result.current.cloneForm.setUsername("x-bitbucket-api-token-auth"));
    // The SSH panel's "Switch to HTTPS" — explicit URL, no setState round-trip.
    act(() => result.current.cloneRecovery.retryWithUrl("https://github.com/octo/repo.git"));

    await waitFor(() => expect(result.current.screen).toBe("opened"));
    expect(cloneUrls).toEqual(["git@github.com:octo/repo.git", "https://github.com/octo/repo.git"]);
    // The form field followed, so a further failure recovers against this URL —
    // and the stale credential state was cleared with the switch.
    expect(result.current.cloneForm.url).toBe("https://github.com/octo/repo.git");
    expect(result.current.cloneForm.username).toBe("");
  });

  it("stores a PR-capable forge's token in the keychain so PRs work too (GL-152)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "save_provider_token") return Promise.resolve({ hasToken: true });
      if (cmd === "clone_repo") return Promise.resolve("/tmp/r");
      if (cmd === "open_repo") {
        return Promise.resolve({ path: "/tmp/r", workdir: "/tmp/r", headBranch: "main", headOid: null, detached: false });
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("https://bitbucket.org/w/r.git"));
    act(() => result.current.cloneForm.setUsername("x-token-auth"));
    act(() => result.current.cloneForm.setPassword("tok"));
    act(() => result.current.cloneRun.start());

    await waitFor(() => expect(result.current.screen).toBe("opened"));
    // Keychain path: token stored as a provider token, NOT sent to the git helper.
    expect(invokeMock).toHaveBeenCalledWith(
      "save_provider_token",
      expect.objectContaining({ provider: "bitbucket", host: "bitbucket.org", token: "tok" }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("approve_https_credential", expect.anything());
    // The clone runs in providerToken mode, not credentialHelper.
    expect(invokeMock).toHaveBeenCalledWith(
      "clone_repo",
      expect.objectContaining({ auth: expect.objectContaining({ mode: "providerToken" }) }),
    );
  });

  it("falls back to the git helper when the keychain write fails (GL-151)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      // The OS keychain write rejects — GitLane must not then clone in
      // providerToken mode against a token it never stored.
      if (cmd === "save_provider_token") return Promise.reject(new Error("keychain locked"));
      if (cmd === "approve_https_credential") return Promise.resolve({ username: "x-token-auth", helper: "store" });
      if (cmd === "clone_repo") return Promise.resolve("/tmp/r");
      if (cmd === "open_repo") {
        return Promise.resolve({ path: "/tmp/r", workdir: "/tmp/r", headBranch: "main", headOid: null, detached: false });
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("https://bitbucket.org/w/r.git"));
    act(() => result.current.cloneForm.setUsername("x-token-auth"));
    act(() => result.current.cloneForm.setPassword("tok"));
    act(() => result.current.cloneRun.start());

    await waitFor(() => expect(result.current.screen).toBe("opened"));
    // The keychain attempt was made and failed…
    expect(invokeMock).toHaveBeenCalledWith("save_provider_token", expect.anything());
    // …so the token was saved to the git helper and the clone ran through it —
    // in credentialHelper mode, NOT a dangling providerToken.
    expect(invokeMock).toHaveBeenCalledWith("approve_https_credential", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith(
      "clone_repo",
      expect.objectContaining({ auth: expect.objectContaining({ mode: "credentialHelper" }) }),
    );
  });

  it("clones into a renamed destination folder (GL-151)", async () => {
    const dests: string[] = [];
    invokeMock.mockImplementation((cmd: string, args?: { dest?: string }) => {
      if (cmd === "clone_repo") {
        dests.push(args?.dest ?? "");
        return Promise.resolve("/tmp/r");
      }
      if (cmd === "open_repo") {
        return Promise.resolve({ path: "/tmp/r", workdir: "/tmp/r", headBranch: "main", headOid: null, detached: false });
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useOnboarding());
    // The folder auto-fills from the URL's repo name…
    act(() => result.current.cloneForm.changeUrl("https://github.com/octo/repo.git"));
    expect(result.current.cloneForm.folder).toBe("repo");
    // …and a manual rename is what the clone actually writes to.
    act(() => result.current.cloneForm.setFolder("my-fork"));
    act(() => result.current.cloneRun.start());

    await waitFor(() => expect(result.current.screen).toBe("opened"));
    expect(dests[0].endsWith("/my-fork")).toBe(true);
  });

  it("blocks the clone when the destination folder name is invalid (GL-151)", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("https://github.com/octo/repo.git"));
    expect(result.current.cloneForm.canClone).toBe(true);
    // A path separator isn't a safe single folder leaf.
    act(() => result.current.cloneForm.setFolder("nested/name"));
    expect(result.current.cloneForm.folderValid).toBe(false);
    expect(result.current.cloneForm.canClone).toBe(false);
  });

  it("keeps the token in the git helper when 'enable pull requests' is off", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "approve_https_credential") return Promise.resolve({ username: "x-token-auth", helper: "store" });
      if (cmd === "clone_repo") return Promise.resolve("/tmp/r");
      if (cmd === "open_repo") {
        return Promise.resolve({ path: "/tmp/r", workdir: "/tmp/r", headBranch: "main", headOid: null, detached: false });
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("https://bitbucket.org/w/r.git"));
    act(() => result.current.cloneForm.setUsername("x-token-auth"));
    act(() => result.current.cloneForm.setPassword("tok"));
    act(() => result.current.cloneForm.setKeychain(false));
    act(() => result.current.cloneRun.start());

    await waitFor(() => expect(result.current.screen).toBe("opened"));
    expect(invokeMock).toHaveBeenCalledWith("approve_https_credential", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("save_provider_token", expect.anything());
  });

  it("keeps unreachable failures non-recoverable", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "clone_repo"
        ? Promise.reject("fatal: unable to access 'https://x.example/': Could not resolve host: x.example")
        : Promise.resolve([]),
    );
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("https://x.example/o/r.git"));
    act(() => result.current.cloneRun.start());
    await waitFor(() => expect(result.current.screen).toBe("error"));
    expect(result.current.cloneRecovery.error?.recoverable).toBe(false);
  });
});

describe("URL-driven transitions", () => {
  it("adopts the URL's user and clears the password when the authority changes", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("https://alice@github.com/octo/repo.git"));
    expect(result.current.cloneForm.username).toBe("alice");

    act(() => result.current.cloneForm.setPassword("secret"));
    act(() => result.current.cloneForm.setKeychain(false));

    // A different credential authority: NOTHING entered for the old one may
    // survive — password cleared, account unpicked, keychain back to default.
    act(() => result.current.cloneForm.changeUrl("https://gitlab.com/group/other.git"));
    expect(result.current.cloneForm.username).toBe("");
    expect(result.current.cloneForm.password).toBe("");
    expect(result.current.cloneForm.accountId).toBeNull();
    expect(result.current.cloneForm.keychain).toBeNull();
    // The destination folder re-derived from the new repo name.
    expect(result.current.cloneForm.folder).toBe("other");
  });

  it("keeps entered credentials across a same-authority path edit", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("https://github.com/octo/repo.git"));
    act(() => result.current.cloneForm.setUsername("me"));
    act(() => result.current.cloneForm.setPassword("secret"));

    act(() => result.current.cloneForm.changeUrl("https://github.com/octo/renamed.git"));

    expect(result.current.cloneForm.username).toBe("me");
    expect(result.current.cloneForm.password).toBe("secret");
    expect(result.current.cloneForm.folder).toBe("renamed");
  });

  it("keeps a manual folder rename until the URL yields a NEW repo name", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("https://github.com/octo/repo.git"));
    expect(result.current.cloneForm.folder).toBe("repo");

    act(() => result.current.cloneForm.setFolder("my-fork"));
    // Same derived name (owner changed, leaf didn't): the rename sticks.
    act(() => result.current.cloneForm.changeUrl("https://github.com/fork-org/repo.git"));
    expect(result.current.cloneForm.folder).toBe("my-fork");

    // A new derived name replaces the stale manual value.
    act(() => result.current.cloneForm.changeUrl("https://github.com/octo/repo2.git"));
    expect(result.current.cloneForm.folder).toBe("repo2");
  });

  it("behaves identically under StrictMode double-invocation", () => {
    const { result } = renderHook(() => useOnboarding(), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    act(() => result.current.cloneForm.changeUrl("https://github.com/octo/repo.git"));
    expect(result.current.cloneForm.folder).toBe("repo");

    act(() => result.current.cloneForm.setFolder("mine"));
    act(() => result.current.cloneForm.setUsername("me"));
    act(() => result.current.cloneForm.changeUrl("https://github.com/octo/repo.git".replace("repo", "repo")));
    // No-op URL write: nothing may reset.
    expect(result.current.cloneForm.folder).toBe("mine");
    expect(result.current.cloneForm.username).toBe("me");

    act(() => result.current.cloneForm.changeUrl("https://gitlab.com/g/x.git"));
    expect(result.current.cloneForm.folder).toBe("x");
    expect(result.current.cloneForm.username).toBe("");
  });
});

describe("overlay unmount during clone", () => {
  it("saves clone tokens even when the HTTPS username is blank", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "approve_https_credential") return Promise.resolve({ username: "", helper: "store" });
      if (cmd === "clone_repo") return Promise.resolve("/tmp/repo");
      if (cmd === "open_repo") {
        return Promise.resolve({
          path: "/tmp/repo",
          workdir: "/tmp/repo",
          headBranch: "main",
          headOid: null,
          detached: false,
        });
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("https://gitlab.com/group/repo.git"));
    act(() => result.current.cloneForm.setUsername(""));
    act(() => result.current.cloneForm.setPassword("token"));
    act(() => result.current.cloneRun.start());

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("approve_https_credential", {
        credentialHost: "gitlab.com",
        path: "group/repo",
        username: "",
        password: "token",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("clone_repo", {
        url: "https://gitlab.com/group/repo.git",
        dest: expect.any(String),
        auth: {
          mode: "credentialHelper",
          provider: "gitlab",
          host: "gitlab.com",
          credentialHost: "gitlab.com",
          username: null,
        },
      }),
    );
  });

  it("cancels an in-flight clone when the hook unmounts mid-progress", async () => {
    useRepo.setState({
      recents: [{ path: "/code/x", name: "x", branch: null, lastOpenedAt: 0 }],
      summary: null,
    });
    // clone_repo stays in flight; other reads (recents_status, cancel_clone) resolve.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "clone_repo" ? new Promise<string>(() => {}) : Promise.resolve([]),
    );

    const { result, unmount } = renderHook(() => useOnboarding());
    act(() => result.current.cloneForm.changeUrl("https://github.com/o/r.git"));
    act(() => result.current.cloneRun.start());
    await waitFor(() => expect(result.current.screen).toBe("progress"));

    unmount();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_clone"));
  });
});
