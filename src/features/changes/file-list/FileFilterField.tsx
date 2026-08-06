import { CloseIcon, SearchIcon } from "@/components/ui/icons";

/** The revealed filter input under the "Changed files" eyebrow (design 3b).
 * Esc and the ✕ both close the field entirely (the owner clears the query). */
export function FileFilterField({
  query,
  onQuery,
  onClose,
}: {
  query: string;
  onQuery: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="mx-2 flex h-8 items-center gap-1.5 rounded-lg border border-black/[0.07] bg-black/[0.04] px-2.5 focus-within:border-[color:var(--accent)] focus-within:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:focus-within:bg-neutral-900">
      <SearchIcon className="h-[15px] w-[15px] shrink-0 text-neutral-400" />
      <input
        // Safe to autofocus: the field only exists because the user just
        // clicked the magnifier to ask for it (same as the history search bar).
        autoFocus
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        // Escape is handled by useFileFilter's document listener, so it closes
        // the field wherever focus sits — not only while this input has it.
        placeholder="Filter files by name…"
        aria-label="Filter files by name"
        // The webview offers form-history suggestions over the results otherwise.
        autoComplete="off"
        spellCheck={false}
        className="m-0 h-full min-w-0 flex-1 bg-transparent p-0 text-[13px] leading-none text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
      />
      {/* Always present (not only with a query) — with an empty field it is the
          only pointer way to close, since the magnifier hides while open. */}
      <button
        type="button"
        title="Close (Esc)"
        aria-label="Close filter"
        onClick={onClose}
        className="grid h-5 w-5 shrink-0 place-items-center rounded text-neutral-400 hover:bg-black/10 hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-200"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
