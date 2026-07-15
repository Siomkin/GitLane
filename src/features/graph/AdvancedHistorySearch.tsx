import { useEffect, useMemo, useRef, useState } from "react";
import type { HistorySearchPage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { CloseIcon } from "@/components/ui/icons";
import { SuggestInput, type SuggestItem } from "@/components/ui/SuggestInput";
import { useRepo } from "@/store/repo";
import { SearchResultsList } from "./SearchResultsList";
import { authorSuggestions, completeRevision, revisionSuggestions } from "./searchSuggestions";
import {
  CHANGED_MODES,
  EMPTY_FIELDS,
  activeFilterChips,
  datePlaceholders,
  formatDateInput,
  isValidDateInput,
  toQuery,
  type ChangedMode,
  type FormFields,
} from "./advancedSearchModel";

function FieldLabel({ children, trailing }: { children: React.ReactNode; trailing?: React.ReactNode }) {
  // A fixed-height label row keeps every input in the grid on the same line —
  // the "Changed code" cell packs its match-mode toggle into this row, which
  // would otherwise make it taller than its neighbours' and push its input down.
  return (
    <span className="mb-1 flex h-5 items-center justify-between">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
        {children}
      </span>
      {trailing}
    </span>
  );
}

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-black/10 bg-white px-2 text-xs text-neutral-800 outline-none focus:border-[var(--accent)] dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-100";

function SearchField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="min-w-0">
      <FieldLabel>{label}</FieldLabel>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={INPUT_CLASS}
      />
    </label>
  );
}

export function AdvancedHistorySearch() {
  const repoPath = useRepo((state) => state.summary?.path ?? null);
  const searchHistory = useRepo((state) => state.searchHistory);
  const suggestTreePaths = useRepo((state) => state.suggestTreePaths);
  const commits = useRepo((state) => state.graph?.commits);
  const branches = useRepo((state) => state.branches);
  const [fields, setFields] = useState(EMPTY_FIELDS);
  // Stable for the mounted panel's lifetime — a re-render at midnight moving
  // the hint by a day is not worth re-deriving per render.
  const [dateHints] = useState(() => datePlaceholders());
  const [changedMode, setChangedMode] = useState<ChangedMode>("literal");
  const [page, setPage] = useState<HistorySearchPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pathItems, setPathItems] = useState<SuggestItem[]>([]);
  // Monotonic token for in-flight search/reveal. A newer search or a repo
  // switch bumps it; a resolving request whose captured token no longer matches
  // is stale and drops its result instead of rendering the wrong repo's data.
  const requestGen = useRef(0);
  // Separate per-invocation token for reveal *ownership* of the `revealing` UI
  // state. Each reveal bumps it; only the reveal that still owns the token
  // clears `revealing`. This is distinct from requestGen because a superseding
  // search must still let the aborted reveal clear its own busy state, while a
  // later reveal of the *same commit id* must NOT be cleared by an older one.
  const revealSeq = useRef(0);

  const update = (key: keyof FormFields, value: string) =>
    setFields((current) => ({ ...current, [key]: value }));
  // Tab on an empty date field adopts its ghost placeholder as the value, so
  // the suggested bound is one keystroke instead of eight digits. Focus still
  // moves on (no preventDefault); the chip that appears makes the fill visible
  // and one × undoes it. Shift+Tab (backing out of the form) never fills.
  const adoptHintOnTab = (key: "since" | "until") => (event: React.KeyboardEvent) => {
    if (event.key === "Tab" && !event.shiftKey && fields[key] === "") {
      update(key, dateHints[key]);
    }
  };
  const clearAll = () => {
    // Bump both tokens so a search/reveal already in flight can't repopulate the
    // cleared results or clobber a later reveal's busy state (mirrors the
    // repo-switch reset).
    requestGen.current += 1;
    revealSeq.current += 1;
    setFields(EMPTY_FIELDS);
    setPage(null);
    setError(null);
    setLoading(false);
    setRevealing(null);
  };

  // The panel stays mounted across repository switches, so a switch must not
  // leave the previous repo's query text or results on screen. Invalidate any
  // in-flight request and reset the surface. (Runs once on mount too, a no-op
  // over the already-empty defaults.)
  useEffect(() => {
    requestGen.current += 1;
    revealSeq.current += 1;
    setFields(EMPTY_FIELDS);
    setPage(null);
    setError(null);
    setPathItems([]);
    setRevealing(null);
    setLoading(false);
  }, [repoPath]);

  const chips = useMemo(() => activeFilterChips(fields, changedMode), [fields, changedMode]);
  // Which date field is being edited right now. Validity gates the search
  // immediately, but the red flagging waits for the value to settle (blur) —
  // half-typed input ("22") shouldn't nag on every keystroke.
  const [editingDate, setEditingDate] = useState<"since" | "until" | null>(null);
  const sinceInvalid = !isValidDateInput(fields.since);
  const untilInvalid = !isValidDateInput(fields.until);
  const datesInvalid = sinceInvalid || untilInvalid;
  const showSinceInvalid = sinceInvalid && editingDate !== "since";
  const showUntilInvalid = untilInvalid && editingDate !== "until";
  const showDatesInvalid = showSinceInvalid || showUntilInvalid;

  const authorItems = useMemo(
    () => authorSuggestions(commits ?? [], fields.author),
    [commits, fields.author],
  );
  const revisionItems = useMemo(
    () => revisionSuggestions(branches, commits ?? [], fields.revision),
    [branches, commits, fields.revision],
  );

  // Path suggestions come from the backend (a HEAD tree walk), so debounce
  // typing and drop stale responses. Best-effort: failures suggest nothing.
  useEffect(() => {
    const filter = fields.path.trim();
    if (!filter) {
      setPathItems([]);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      suggestTreePaths(filter)
        .then((paths) => {
          if (!stale) setPathItems(paths.map((path) => ({ value: path })));
        })
        .catch(() => {
          if (!stale) setPathItems([]);
        });
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [fields.path, suggestTreePaths]);

  const search = async () => {
    // Also guarded here (not just the disabled button) so implicit form
    // submission can't run a query that would silently drop an invalid date.
    if (!repoPath || loading || datesInvalid) return;
    const gen = (requestGen.current += 1);
    setLoading(true);
    setError(null);
    try {
      const result = await searchHistory(toQuery(fields, changedMode));
      if (requestGen.current !== gen) return; // superseded by a newer search / repo switch
      setPage(result);
    } catch (searchError) {
      if (requestGen.current !== gen) return;
      setPage(null);
      setError(String(searchError));
    } finally {
      if (requestGen.current === gen) setLoading(false);
    }
  };

  const reveal = async (id: string) => {
    // Ride the current generation without bumping it — reveal shouldn't
    // invalidate a search, but a repo switch mid-reveal (which does bump) must
    // abort this loop before it pages the *new* repo's graph looking for an id
    // that only exists in the old one.
    const gen = requestGen.current;
    // Claim a fresh ownership token so only this invocation clears `revealing`
    // — an older reveal of the same id (after a Clear all + re-search) must not
    // re-enable the rows a newer reveal is still using.
    const seq = (revealSeq.current += 1);
    setRevealing(id);
    setError(null);
    try {
      // Search covers every reachable ref, while the graph is deliberately
      // bounded. Page it only after an explicit result click, stopping if a
      // failed/no-op page leaves the limit unchanged.
      for (let pageCount = 0; pageCount < 50; pageCount += 1) {
        if (requestGen.current !== gen) return;
        const state = useRepo.getState();
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
      if (requestGen.current === gen) setError(String(revealError));
    } finally {
      // Clear only if this invocation still owns the token. A newer search that
      // aborts this reveal leaves `revealSeq` untouched, so we still clear (rows
      // re-enable); but a Clear all / repo switch / newer reveal bumps it, so a
      // superseded older reveal can't clobber the current busy state.
      if (revealSeq.current === seq) setRevealing(null);
    }
  };

  return (
    <div className="border-b border-black/5 bg-black/[0.015] px-4 py-3 dark:border-white/5 dark:bg-white/[0.02]">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <SearchField label="Message" placeholder="regex — fix|refactor" value={fields.message} onChange={(value) => update("message", value)} />
          <label className="min-w-0">
            <FieldLabel>Author</FieldLabel>
            <SuggestInput
              value={fields.author}
              onChange={(value) => update("author", value)}
              onPick={(value) => update("author", value)}
              items={authorItems}
              placeholder="name or email"
              className={INPUT_CLASS}
              hintPlacement="inline"
            />
          </label>
          <label className="min-w-0">
            <FieldLabel>File path</FieldLabel>
            <SuggestInput
              value={fields.path}
              onChange={(value) => update("path", value)}
              onPick={(value) => update("path", value)}
              items={pathItems}
              placeholder="src/store"
              className={INPUT_CLASS}
            />
          </label>
          <label className="min-w-0">
            <FieldLabel>Revision or range</FieldLabel>
            <SuggestInput
              value={fields.revision}
              onChange={(value) => update("revision", value)}
              onPick={(value) => update("revision", completeRevision(fields.revision, value))}
              items={revisionItems}
              placeholder="main or main..feature"
              className={INPUT_CLASS}
            />
          </label>
          <label className="min-w-0">
            <FieldLabel
              trailing={
                <span role="radiogroup" aria-label="Changed code match mode" className="flex gap-0.5">
                  {CHANGED_MODES.map((mode) => (
                    <button
                      key={mode.key}
                      type="button"
                      role="radio"
                      aria-checked={changedMode === mode.key}
                      onClick={() => setChangedMode(mode.key)}
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium leading-none transition-colors",
                        changedMode === mode.key
                          ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                          : "text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5",
                      )}
                    >
                      {mode.label}
                    </button>
                  ))}
                </span>
              }
            >
              Changed code
            </FieldLabel>
            <input
              value={fields.changed}
              onChange={(event) => update("changed", event.target.value)}
              placeholder={changedMode === "literal" ? "invoke(" : "invoke\\("}
              className={INPUT_CLASS}
            />
          </label>
          <div className="min-w-0">
            <FieldLabel>Date range</FieldLabel>
            <div className="flex items-center gap-1.5">
              <input
                value={fields.since}
                onChange={(event) => update("since", formatDateInput(event.target.value))}
                placeholder={dateHints.since}
                inputMode="numeric"
                aria-label="Committed after"
                aria-invalid={showSinceInvalid || undefined}
                onKeyDown={adoptHintOnTab("since")}
                onFocus={() => setEditingDate("since")}
                onBlur={() => setEditingDate(null)}
                className={cn(
                  INPUT_CLASS,
                  showSinceInvalid && "border-red-400 focus:border-red-400 dark:border-red-500/70",
                )}
              />
              <span className="text-[10px] text-neutral-400">to</span>
              <input
                value={fields.until}
                onChange={(event) => update("until", formatDateInput(event.target.value))}
                placeholder={dateHints.until}
                inputMode="numeric"
                aria-label="Committed before"
                aria-invalid={showUntilInvalid || undefined}
                onKeyDown={adoptHintOnTab("until")}
                onFocus={() => setEditingDate("until")}
                onBlur={() => setEditingDate(null)}
                className={cn(
                  INPUT_CLASS,
                  showUntilInvalid && "border-red-400 focus:border-red-400 dark:border-red-500/70",
                )}
              />
            </div>
          </div>
        </div>
        {chips.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {chips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--accent-soft)] py-0.5 pl-2 pr-1 text-[11px] font-medium text-[color:var(--accent)]"
              >
                <span className="truncate">{chip.label}</span>
                <button
                  type="button"
                  onClick={() => update(chip.key, "")}
                  aria-label={`Remove ${chip.label} filter`}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={clearAll}
              className="ml-0.5 text-[11px] font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
            >
              Clear all
            </button>
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className={cn("text-[10px]", showDatesInvalid ? "text-red-500 dark:text-red-400" : "text-neutral-400")}>
            {showDatesInvalid
              ? `Dates must be YYYY-MM-DD, like ${dateHints.since}.`
              : "Non-empty filters are combined."}
          </span>
          <button
            type="submit"
            disabled={!repoPath || loading || datesInvalid}
            className="h-7 rounded-md bg-[var(--accent)] px-3 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            {loading ? "Searching…" : "Search repository"}
          </button>
        </div>
      </form>

      {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {page && (
        <div className="mt-3">
          <SearchResultsList
            results={page.results}
            onSelect={(id) => void reveal(id)}
            busyId={revealing}
            truncated={page.truncated}
            truncatedLabel={
              page.workTruncated
                ? "Showing partial results — narrow the revision or date range."
                : "Showing the first 200 matches."
            }
            emptyLabel={page.workTruncated ? "No matches in the scanned history." : undefined}
          />
        </div>
      )}
    </div>
  );
}
