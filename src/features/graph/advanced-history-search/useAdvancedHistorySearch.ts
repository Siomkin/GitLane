import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BranchInfo,
  CommitNode,
  HistorySearchPage,
  HistorySearchQuery,
} from "@/lib/api";
import type { SuggestItem } from "@/components/ui/SuggestInput";
import { useRepo } from "@/store/repo";
import {
  EMPTY_FIELDS,
  activeFilterChips,
  datePlaceholders,
  formatDateInput,
  isValidDateInput,
  toQuery,
  type ChangedMode,
  type FormFields,
} from "./advancedSearchModel";
import { authorSuggestions, revisionSuggestions } from "./searchSuggestions";
import type { AdvancedHistorySearchFormProps } from "./AdvancedHistorySearchForm";
import type { AdvancedHistorySearchResultsProps } from "./AdvancedHistorySearchResults";

interface SearchSession {
  repoPath: string | null;
  fields: FormFields;
  page: HistorySearchPage | null;
  loading: boolean;
  revealing: string | null;
  error: string | null;
  pathItems: SuggestItem[];
}

interface AdvancedHistorySearchDependencies {
  repoPath: string | null;
  searchHistory: (query: HistorySearchQuery) => Promise<HistorySearchPage>;
  suggestTreePaths: (filter: string) => Promise<string[]>;
  commits: CommitNode[];
  branches: BranchInfo[];
}

export interface AdvancedHistorySearchController {
  form: AdvancedHistorySearchFormProps;
  results: AdvancedHistorySearchResultsProps;
}

const emptySession = (repoPath: string | null): SearchSession => ({
  repoPath,
  fields: EMPTY_FIELDS,
  page: null,
  loading: false,
  revealing: null,
  error: null,
  pathItems: [],
});

/**
 * Owns the advanced-search composer and async request session. The rendered
 * form/results remain prop-only; repo, request-generation, debounce, and reveal
 * paging behavior stays here at the controller boundary.
 */
export function useAdvancedHistorySearch({
  repoPath,
  searchHistory,
  suggestTreePaths,
  commits,
  branches,
}: AdvancedHistorySearchDependencies): AdvancedHistorySearchController {
  const [session, setSession] = useState(() => emptySession(repoPath));
  // Stable for the mounted panel's lifetime — a re-render at midnight moving
  // the hint by a day is not worth re-deriving per render.
  const [dateHints] = useState(() => datePlaceholders());
  const [changedMode, setChangedMode] = useState<ChangedMode>("literal");
  // Which date field is being edited right now. Validity gates the search
  // immediately, but the red flagging waits for the value to settle (blur).
  const [editingDate, setEditingDate] = useState<"since" | "until" | null>(null);

  // The old component's mount reset advanced both tokens before interaction.
  // Start at that same generation and preserve their distinct ownership roles.
  const requestGen = useRef(1);
  const revealSeq = useRef(1);
  const suggestionGen = useRef(0);

  let current = session;
  if (session.repoPath !== repoPath) {
    // React applies this render-phase adjustment before committing children, so
    // no old-repo fields, results, errors, busy state, or suggestions can flash.
    // changedMode/dateHints/editingDate remain mounted, matching the prior reset's
    // deliberately preserved local composer state. Deriving state is all this
    // does — the token bumps below are side effects and stay out of render.
    current = emptySession(repoPath);
    setSession(current);
  }

  // Invalidate async work owned by a repository we have left, and by the panel
  // when it unmounts. This belongs in a committed effect rather than in render:
  // a concurrent render that React abandons would advance a generation without
  // committing the matching reset, and the in-flight search still holding that
  // generation would then drop its own `loading: false` and strand the spinner.
  //
  // Nothing below depends on the bump for cross-repository safety — every
  // `setSession` rejects a state whose `repoPath` has moved on, so a late
  // response cannot write into the new session either way.
  useEffect(
    () => () => {
      requestGen.current += 1;
      revealSeq.current += 1;
      suggestionGen.current += 1;
    },
    [repoPath],
  );

  const update = (key: keyof FormFields, value: string) => {
    const nextValue = key === "since" || key === "until" ? formatDateInput(value) : value;
    setSession((state) =>
      state.repoPath === repoPath
        ? { ...state, fields: { ...state.fields, [key]: nextValue } }
        : state,
    );
  };

  const clearAll = () => {
    // A clear supersedes search and reveal, but intentionally preserves match
    // mode, date hints, editing state, and the suggestion cache until the empty
    // path effect clears it — exactly the previous field/reset contract.
    requestGen.current += 1;
    revealSeq.current += 1;
    setSession((state) =>
      state.repoPath === repoPath
        ? {
            ...state,
            fields: EMPTY_FIELDS,
            page: null,
            error: null,
            loading: false,
            revealing: null,
          }
        : state,
    );
  };

  const chips = useMemo(
    () => activeFilterChips(current.fields, changedMode),
    [current.fields, changedMode],
  );
  const sinceInvalid = !isValidDateInput(current.fields.since);
  const untilInvalid = !isValidDateInput(current.fields.until);
  const datesInvalid = sinceInvalid || untilInvalid;
  const showSinceInvalid = sinceInvalid && editingDate !== "since";
  const showUntilInvalid = untilInvalid && editingDate !== "until";
  const showDatesInvalid = showSinceInvalid || showUntilInvalid;

  const authorItems = useMemo(
    () => authorSuggestions(commits, current.fields.author),
    [commits, current.fields.author],
  );
  const revisionItems = useMemo(
    () => revisionSuggestions(branches, commits, current.fields.revision),
    [branches, commits, current.fields.revision],
  );

  // Path suggestions come from the backend, so debounce typing and reject work
  // owned by a superseded filter or repository. The live store check prevents a
  // timer captured for repo A from invoking the stable store action against B.
  useEffect(() => {
    const filter = current.fields.path.trim();
    const gen = (suggestionGen.current += 1);
    if (!filter) {
      setSession((state) =>
        state.repoPath === repoPath && state.pathItems.length > 0
          ? { ...state, pathItems: [] }
          : state,
      );
      return;
    }

    let stale = false;
    const timer = setTimeout(() => {
      if (
        stale ||
        suggestionGen.current !== gen ||
        (useRepo.getState().summary?.path ?? null) !== repoPath
      ) {
        return;
      }
      suggestTreePaths(filter)
        .then((paths) => {
          if (
            stale ||
            suggestionGen.current !== gen ||
            (useRepo.getState().summary?.path ?? null) !== repoPath
          ) {
            return;
          }
          setSession((state) =>
            state.repoPath === repoPath
              ? { ...state, pathItems: paths.map((path) => ({ value: path })) }
              : state,
          );
        })
        .catch(() => {
          if (stale || suggestionGen.current !== gen) return;
          setSession((state) =>
            state.repoPath === repoPath ? { ...state, pathItems: [] } : state,
          );
        });
    }, 200);

    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [current.fields.path, repoPath, suggestTreePaths]);

  const search = async () => {
    // Guard the action as well as the disabled button so implicit submission
    // cannot run a query that would silently drop an invalid date.
    if (!repoPath || current.loading || datesInvalid) return;
    const gen = (requestGen.current += 1);
    setSession((state) =>
      state.repoPath === repoPath ? { ...state, loading: true, error: null } : state,
    );
    try {
      const result = await searchHistory(toQuery(current.fields, changedMode));
      if (requestGen.current !== gen) return;
      setSession((state) =>
        state.repoPath === repoPath ? { ...state, page: result } : state,
      );
    } catch (searchError) {
      if (requestGen.current !== gen) return;
      setSession((state) =>
        state.repoPath === repoPath
          ? { ...state, page: null, error: String(searchError) }
          : state,
      );
    } finally {
      if (requestGen.current === gen) {
        setSession((state) =>
          state.repoPath === repoPath ? { ...state, loading: false } : state,
        );
      }
    }
  };

  const reveal = async (id: string) => {
    // Reveal rides the current search generation: it must not invalidate a
    // search, but a newer search/repo switch can invalidate the paging loop.
    const gen = requestGen.current;
    const seq = (revealSeq.current += 1);
    setSession((state) =>
      state.repoPath === repoPath ? { ...state, revealing: id, error: null } : state,
    );
    try {
      for (let pageCount = 0; pageCount < 50; pageCount += 1) {
        if (requestGen.current !== gen) return;
        // Live reads are intentional: each page can replace graph/limit/actions,
        // and reveal must observe that new state rather than captured selectors.
        const state = useRepo.getState();
        // Check the live repository directly rather than trusting the token
        // alone. The generation bump now lands in a committed effect, so a repo
        // switch leaves a brief window where it has not fired yet — paging must
        // never run against a repository this reveal was not started for.
        if ((state.summary?.path ?? null) !== repoPath) return;
        if (state.graph?.commits.some((commit) => commit.id === id)) {
          await state.revealCommit(id);
          return;
        }
        if (!state.graph?.truncated) break;
        const previousLimit = state.graphLimit;
        await state.loadMoreHistory();
        if (useRepo.getState().graphLimit === previousLimit) break;
      }
      if (requestGen.current !== gen) return;
      throw new Error("The commit is reachable in search but outside the graph's loaded ref set.");
    } catch (revealError) {
      if (requestGen.current === gen) {
        setSession((state) =>
          state.repoPath === repoPath ? { ...state, error: String(revealError) } : state,
        );
      }
    } finally {
      // Search invalidation leaves revealSeq untouched so the old reveal clears
      // its busy row; clear/repo switch/new reveal take ownership by bumping it.
      if (revealSeq.current === seq) {
        setSession((state) =>
          state.repoPath === repoPath ? { ...state, revealing: null } : state,
        );
      }
    }
  };

  const onDateKeyDown = (
    key: "since" | "until",
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === "Tab" && !event.shiftKey && current.fields[key] === "") {
      update(key, dateHints[key]);
    }
  };

  return {
    form: {
      fields: current.fields,
      dateHints,
      changedMode,
      chips,
      authorItems,
      pathItems: current.pathItems,
      revisionItems,
      showSinceInvalid,
      showUntilInvalid,
      showDatesInvalid,
      loading: current.loading,
      searchDisabled: !repoPath || current.loading || datesInvalid,
      onUpdate: update,
      onChangedModeChange: setChangedMode,
      onDateKeyDown,
      onDateFocus: setEditingDate,
      onDateBlur: () => setEditingDate(null),
      onClearAll: clearAll,
      onSearch: () => void search(),
    },
    results: {
      error: current.error,
      page: current.page,
      revealing: current.revealing,
      onReveal: (id) => void reveal(id),
    },
  };
}
