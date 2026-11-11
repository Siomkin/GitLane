// The recent-repositories list: one list, most recently opened first, with a
// group shown only as a colour dot on its rows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { RecentRepo } from "@/store/repoSession";
import { useUi } from "@/store/ui";
import type { OnboardingApi } from "@/features/onboarding/flows/useOnboarding";
import { HomeScreen } from "./HomeScreen";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const recent = (path: string, name: string, lastOpenedAt: number): RecentRepo => ({
  path,
  name,
  branch: "main",
  lastOpenedAt,
});

const ACME = recent("/dev/acme/frontend", "frontend", 3);
const ACME_API = recent("/dev/acme/backend", "backend", 2);
const NOTES = recent("/dev/notes", "notes", 1);

const homeApi = (recents: RecentRepo[]) =>
  ({
    recents,
    openRecent: vi.fn(),
    clearRecents: vi.fn(),
    removeRecent: vi.fn(),
    goClone: vi.fn(),
    goInit: vi.fn(),
    openLocal: vi.fn(),
  }) as unknown as OnboardingApi;

beforeEach(() => {
  useUi.setState({ repoGroups: [], repoLabelsByIdentity: {} });
});

describe("HomeScreen recents", () => {
  it("keeps recency order and marks grouped rows with a dot, not a section", () => {
    const acme = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().assignRepoGroup(ACME.path, acme);

    render(<HomeScreen ob={homeApi([ACME, NOTES, ACME_API])} />);

    const order = screen.getAllByText(/^(frontend|backend|notes)$/).map((el) => el.textContent);
    expect(order).toEqual(["frontend", "notes", "backend"]);
    expect(screen.getAllByRole("img", { name: "Acme" })).toHaveLength(1);
    expect(screen.queryByText("Ungrouped")).toBeNull();
  });

  it("labels the last-open time (epoch ms) with the shared long relative age", () => {
    render(<HomeScreen ob={homeApi([recent("/dev/x", "x", Date.now() - 26 * 3_600_000)])} />);

    expect(screen.getByText("1 day ago")).toBeInTheDocument();
  });

  it("shows a repository's custom name in the list", () => {
    useUi.getState().setRepoName(ACME.path, "Acme · frontend");

    render(<HomeScreen ob={homeApi([ACME])} />);

    expect(screen.getByText("Acme · frontend")).toBeInTheDocument();
    expect(screen.queryByText("frontend")).toBeNull();
  });

  it("keeps a name and group after the recents list is cleared and the repo returns", () => {
    const acme = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().assignRepoGroup(ACME.path, acme);
    useUi.getState().setRepoName(ACME.path, "Acme · frontend");

    // Recents are wiped (the "Clear" button) and the repo is opened again later.
    const { rerender } = render(<HomeScreen ob={homeApi([])} />);
    rerender(<HomeScreen ob={homeApi([ACME])} />);

    expect(screen.getByRole("img", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByText("Acme · frontend")).toBeInTheDocument();
  });

  it("gives a worktree row the name and group of the repository it belongs to", () => {
    const acme = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().assignRepoGroup(ACME.path, acme);
    useUi.getState().setRepoName(ACME.path, "Acme · frontend");
    // Opened as a worktree, so the entry's own path is the worktree's — only
    // `mainPath` ties it back to the repository carrying the name and group.
    const worktree: RecentRepo = {
      ...recent("/dev/acme/frontend-wt", "frontend-wt", 2),
      mainPath: ACME.path,
    };

    render(<HomeScreen ob={homeApi([ACME, worktree])} />);

    // Both rows carry the Acme dot, and the worktree row shows the
    // repository's custom name, not its folder.
    expect(screen.getAllByRole("img", { name: "Acme" })).toHaveLength(2);
    expect(screen.queryByText("frontend-wt")).toBeNull();
    expect(screen.getAllByText("Acme · frontend")).toHaveLength(2);
  });

  it("removes one entry with its × without opening it", () => {
    const ob = homeApi([ACME, NOTES]);
    render(<HomeScreen ob={ob} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove notes from recent repositories" }));
    expect(ob.removeRecent).toHaveBeenCalledWith(NOTES);
    expect(ob.openRecent).not.toHaveBeenCalled();
  });
});
