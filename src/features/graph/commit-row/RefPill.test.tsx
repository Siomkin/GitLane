// The in-place pending state: the pill the user checked out spins until the
// checkout settles, only in the repository the checkout runs in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RefKind, type RefLabel, type RepoSummary } from "@/lib/api";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { useNotifications } from "@/store/notifications";
import { useRepo } from "@/store/repo";
import { CombinedRefPill } from "./CombinedRefPill";
import { RefPill } from "./RefPill";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "1111111",
  detached: false,
  unborn: false,
  isWorktree: false,
};
const remote: RefLabel = { name: "origin/develop", kind: RefKind.Remote };
const local: RefLabel = { name: "develop", kind: RefKind.Branch };

/** The pill element around a ref's name (exact text, so `develop` ≠ `origin/develop`). */
const pill = (name: string) => screen.getByText(name).parentElement!;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  useNotifications.getState().dismissAll();
  useRepo.setState({ summary, worktrees: [], branches: [], checkoutPending: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RefPill pending checkout", () => {
  it("spins only on the ref being checked out", () => {
    useRepo.setState({ checkoutPending: { "/repo": { ref: "origin/develop", kind: "remote" } } });
    render(
      <>
        <RefPill refLabel={remote} current={false} targetSha="abc" />
        <RefPill refLabel={local} current={false} targetSha="abc" />
      </>,
    );
    expect(pill("origin/develop")).toHaveAttribute("aria-busy", "true");
    expect(pill("origin/develop").querySelector(".animate-spin")).not.toBeNull();
    expect(pill("develop")).not.toHaveAttribute("aria-busy");
    expect(pill("develop").querySelector(".animate-spin")).toBeNull();
  });

  it("spins the branch, not the same-named tag, when git would switch to the branch", () => {
    const tag: RefLabel = { name: "v1.0", kind: RefKind.Tag };
    const branch: RefLabel = { name: "v1.0", kind: RefKind.Branch };
    useRepo.setState({
      checkoutPending: { "/repo": { ref: "v1.0", kind: "local" } },
      branches: [{ name: "v1.0", kind: "local", target: "abc", isHead: false, upstream: null, remote: null }],
    });
    render(
      <>
        <RefPill refLabel={tag} current={false} targetSha="abc" />
        <RefPill refLabel={branch} current={false} targetSha="abc" />
      </>,
    );
    const [tagPill, branchPill] = screen.getAllByText("v1.0").map((el) => el.parentElement!);
    expect(tagPill).not.toHaveAttribute("aria-busy");
    expect(branchPill).toHaveAttribute("aria-busy", "true");
  });

  it("spins a tag being checked out when no branch shares its name", () => {
    useRepo.setState({ checkoutPending: { "/repo": { ref: "v1.0", kind: "local" } } });
    render(<RefPill refLabel={{ name: "v1.0", kind: RefKind.Tag }} current={false} targetSha="abc" />);
    expect(pill("v1.0")).toHaveAttribute("aria-busy", "true");
  });

  it("does not spin for a checkout running in another repository", () => {
    useRepo.setState({ checkoutPending: { "/other": { ref: "origin/develop", kind: "remote" } } });
    render(<RefPill refLabel={remote} current={false} targetSha="abc" />);
    expect(pill("origin/develop")).not.toHaveAttribute("aria-busy");
    expect(document.querySelector(".animate-spin")).toBeNull();
  });
});

describe("CombinedRefPill pending checkout", () => {
  it("spins when its remote member is being checked out", () => {
    useRepo.setState({ checkoutPending: { "/repo": { ref: "origin/develop", kind: "remote" } } });
    render(
      <CombinedRefPill
        base="develop"
        local={local}
        remotes={[remote]}
        current={false}
        expanded={false}
        onToggle={() => {}}
        targetSha="abc"
      />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows its normal glyph when nothing is pending", () => {
    render(
      <CombinedRefPill
        base="develop"
        local={local}
        remotes={[remote]}
        current={false}
        expanded={false}
        onToggle={() => {}}
        targetSha="abc"
      />,
    );
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-busy");
    expect(document.querySelector(".animate-spin")).toBeNull();
  });
});

describe("RefPill double-click", () => {
  it("drops a repeat double-click while the checkout runs, without an error", async () => {
    vi.useFakeTimers();
    let finish = () => {};
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "checkout"
        ? new Promise<string>((resolve) => (finish = () => resolve("")))
        : emptyIpcInvoke(cmd),
    );
    render(<RefPill refLabel={local} current={false} targetSha="abc" />);

    fireEvent.doubleClick(pill("develop"));
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.doubleClick(pill("develop"));
    await vi.advanceTimersByTimeAsync(0);

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "checkout")).toHaveLength(1);
    expect(useNotifications.getState().toasts.filter((t) => t.kind === "error")).toEqual([]);
    finish();
    await vi.runAllTimersAsync();
    expect(useRepo.getState().checkoutPending).toEqual({});
  });

  it("says which checkout is running when another ref is double-clicked", async () => {
    useRepo.setState({ checkoutPending: { "/repo": { ref: "origin/develop", kind: "remote" } } });
    render(<RefPill refLabel={local} current={false} targetSha="abc" />);

    fireEvent.doubleClick(pill("develop"));
    await vi.waitFor(() =>
      expect(useNotifications.getState().toasts).toEqual([
        expect.objectContaining({
          kind: "error",
          title: expect.stringMatching(/checkout of origin\/develop is already running/),
        }),
      ]),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("checkout", expect.anything());
  });

  it("still toasts an ordinary checkout failure and stops spinning", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "checkout" ? Promise.reject(new Error("local changes would be overwritten")) : emptyIpcInvoke(cmd),
    );
    render(<RefPill refLabel={local} current={false} targetSha="abc" />);

    fireEvent.doubleClick(pill("develop"));
    await vi.waitFor(() =>
      expect(useNotifications.getState().toasts).toEqual([
        expect.objectContaining({ kind: "error", title: expect.stringMatching(/local changes/) }),
      ]),
    );
    expect(pill("develop")).not.toHaveAttribute("aria-busy");
    expect(useRepo.getState().checkoutPending).toEqual({});
  });
});
