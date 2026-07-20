import { useUi } from "@/store/ui";
import { PlusIcon, SearchIcon } from "@/components/ui/icons";

/** Centered empty state for the navigator list pane: names what didn't match
 * (or that the category has nothing yet), and — in a branch context with a
 * query — offers to create a branch named after the query, opening the
 * existing create-branch dialog prefilled (branches from HEAD). */
export function NavEmptyState({
  kind,
  query,
  canCreate,
}: {
  /** Singular noun for the active category ("branch", "remote", "ref", …). */
  kind: string;
  query: string;
  /** Offer the "Create branch <query>" action (branches/All with a query). */
  canCreate: boolean;
}) {
  const closeNav = useUi((s) => s.closeNav);
  const openCreateBranchNamed = useUi((s) => s.openCreateBranchNamed);
  return (
    <div className="flex h-full min-h-[300px] flex-col items-center justify-center px-5 text-center">
      <SearchIcon className="h-9 w-9 text-neutral-300 dark:text-neutral-600" strokeWidth="1.5" />
      <p className="mt-3 text-[13px] text-neutral-500 dark:text-neutral-400">
        {query !== "" ? (
          <>
            No {kind} matches{" "}
            <span className="font-mono text-neutral-700 dark:text-neutral-200">{query}</span>
          </>
        ) : (
          <>No {kind}s yet</>
        )}
      </p>
      {canCreate && query !== "" && (
        <button
          type="button"
          className="mt-4 flex h-8 items-center gap-2 rounded-lg bg-[var(--accent)] px-3 text-[13px] font-medium text-white"
          onClick={() => {
            closeNav();
            openCreateBranchNamed(query);
          }}
        >
          <PlusIcon className="h-3.5 w-3.5" strokeWidth="2" />
          Create branch <span className="font-mono opacity-90">{query}</span>
        </button>
      )}
    </div>
  );
}
