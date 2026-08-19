// The recent-repositories list: grouped into sections when the user has groups,
// and unchanged (one flat list, no headings) when they don't.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    goClone: vi.fn(),
    goInit: vi.fn(),
    openLocal: vi.fn(),
  }) as unknown as OnboardingApi;

beforeEach(() => {
  useUi.setState({ repoGroups: [], repoLabelsByIdentity: {} });
});

describe("HomeScreen recents", () => {
  it("renders one flat list with no headings when nothing is grouped", () => {
    render(<HomeScreen ob={homeApi([ACME, NOTES])} />);

    expect(screen.queryByText("Ungrouped")).toBeNull();
    expect(screen.getByText("frontend")).toBeInTheDocument();
    expect(screen.getByText("notes")).toBeInTheDocument();
  });

  it("sections grouped repositories, ungrouped last, recency kept inside a section", () => {
    const acme = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().assignRepoGroup(ACME.path, acme);
    useUi.getState().assignRepoGroup(ACME_API.path, acme);

    render(<HomeScreen ob={homeApi([ACME, ACME_API, NOTES])} />);

    const headings = ["Acme", "Ungrouped"].map((t) => screen.getByText(t));
    expect(headings).toHaveLength(2);
    // The Acme heading precedes both of its repos, and the ungrouped one follows.
    const order = screen
      .getAllByText(/^(Acme|Ungrouped|frontend|backend|notes)$/)
      .map((el) => el.textContent);
    expect(order).toEqual(["Acme", "frontend", "backend", "Ungrouped", "notes"]);
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

    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Acme · frontend")).toBeInTheDocument();
  });

  it("sections a worktree row with the repository it belongs to, under its name", () => {
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

    // Both rows sit in the Acme section (no ungrouped remainder to head), and
    // the worktree row shows the repository's custom name, not its folder.
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.queryByText("Ungrouped")).toBeNull();
    expect(screen.queryByText("frontend-wt")).toBeNull();
    expect(screen.getAllByText("Acme · frontend")).toHaveLength(2);
  });
});
