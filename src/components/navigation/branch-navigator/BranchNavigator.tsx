import { useUi } from "@/store/ui";
import { CloseIcon, SearchIcon } from "@/components/ui/icons";
import { useNavigatorSections } from "./useNavigatorSections";
import { BranchRow, Section, StashRow, WorktreeRow } from "./rows";

// The branch / worktree / stash navigator: a narrow single-column dropdown (per
// the design) raised by the "Checked out" trigger. Picking a branch, remote, tag
// or worktree jumps the graph to its tip (see `revealCommit`); stashes jump to
// their graph row. This component is just composition + the search box — the
// section data lives in `useNavigatorSections`, the row behaviour in
// `useRowActions`, and the ref→oid resolution in `refs`.
export function BranchNavigator() {
  const filter = useUi((s) => s.filter);
  const setFilter = useUi((s) => s.setFilter);
  const { locals, remotes, tags, worktrees, stashes, head, filtering, isEmpty, hasMatches } =
    useNavigatorSections(filter);

  return (
    <div className="flex flex-col">
      <div className="p-2.5">
        <div className="flex h-8 items-center gap-2 rounded-lg bg-black/[0.05] px-2.5 dark:bg-white/[0.06]">
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search branches"
            className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
          />
          {filter !== "" && (
            <button
              type="button"
              title="Clear branch search"
              aria-label="Clear branch search"
              className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setFilter("")}
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="max-h-[440px] space-y-4 overflow-auto px-2 pb-3">
        {filtering && !hasMatches && !isEmpty && (
          <div className="px-2 pt-1 text-center text-[12px] text-neutral-400">No matches</div>
        )}
        {locals.length > 0 && (
          <Section label="Local">
            {locals.map((b) => (
              <BranchRow
                key={b.name}
                name={b.name}
                kind="local"
                oid={b.oid}
                isCurrent={b.name === head}
                dimmed={filtering && !b.match}
                query={filter}
                sync={b.sync}
                worktree={b.worktree}
              />
            ))}
          </Section>
        )}
        {remotes.length > 0 && (
          <Section label="Remotes">
            {remotes.map((b) => (
              <BranchRow
                key={b.name}
                name={b.name}
                kind="remote"
                oid={b.oid}
                dimmed={filtering && !b.match}
                query={filter}
              />
            ))}
          </Section>
        )}
        {tags.length > 0 && (
          <Section label="Tags">
            {tags.map((t) => (
              <BranchRow
                key={t.name}
                name={t.name}
                kind="tag"
                oid={t.oid}
                dimmed={filtering && !t.match}
                query={filter}
              />
            ))}
          </Section>
        )}
        {worktrees.length > 0 && (
          <Section label="Worktrees">
            {worktrees.map((w) => (
              <WorktreeRow key={w.wt.path} wt={w.wt} oid={w.oid} isActive={w.isActive} dimmed={filtering && !w.match} query={filter} />
            ))}
          </Section>
        )}
        {stashes.length > 0 && (
          <Section label="Stashes">
            {stashes.map((s) => (
              <StashRow key={s.stash.index} stash={s.stash} dimmed={filtering && !s.match} query={filter} />
            ))}
          </Section>
        )}
        {isEmpty && <div className="px-2 py-6 text-center text-[12px] text-neutral-400">Nothing here yet</div>}
      </div>
    </div>
  );
}
