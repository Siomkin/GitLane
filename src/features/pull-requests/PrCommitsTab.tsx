// PR Commits tab. The PR detail fetch carries a fast first-paint commit list
// (gh pr view --json …,commits), but that projection is capped and has no
// signature data. So on open this lazily loads the full, verified commit list
// via paginated GraphQL (`loadPrCommits`) and *replaces* the cached list —
// `verified` is reliable structured data (signature.isValid), never inferred.
import { useEffect, useState } from "react";
import { openExternalUrl } from "@/lib/openExternal";
import { cn } from "@/lib/cn";
import type { PrCommitView, PullRequest } from "@/lib/prs";
import { usePulls } from "@/store/pulls";
import { useUi } from "@/store/ui";
import { GitHubIcon } from "@/components/ui/icons";
import { Loading, LoadError } from "@/components/ui/Loading";

export function PrCommitsTab({ pr }: { pr: PullRequest }) {
  const loadPrCommits = usePulls((s) => s.loadPrCommits);
  const commitsError = usePulls((s) => s.prCommitsError[pr.num]);
  const commitsLoaded = usePulls((s) => s.prCommitsLoaded[pr.num]);
  const prsFetchedAt = usePulls((s) => s.prsFetchedAt);

  useEffect(() => {
    void loadPrCommits(pr.num);
  }, [pr.num, prsFetchedAt, loadPrCommits]);

  if (pr.commits.length === 0) {
    // With no fast-path list to fall back on, the full load is the whole
    // story — tri-state like the Diff/Checks tabs: error → blocking retry,
    // still in flight → spinner, confirmed-loaded → the real empty state.
    if (commitsError) {
      return <LoadError message={commitsError} onRetry={() => void loadPrCommits(pr.num, true)} />;
    }
    if (!commitsLoaded) {
      return <Loading label="Loading commits…" />;
    }
    return (
      <div className="py-10 text-center text-[13px] text-neutral-400">
        No commits on this pull request.
      </div>
    );
  }
  return (
    <>
      {/* The full-list load is supplementary — the capped `gh pr view` list
          below still renders — so a failure gets a quiet notice, not a
          blocking error state (GL-165). */}
      {commitsError && (
        <div
          role="status"
          className="mb-2.5 flex items-center gap-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-300"
        >
          <span className="min-w-0 flex-1">
            Couldn't load the full commit list — showing a capped one; signature
            badges may be missing.
          </span>
          <button
            type="button"
            onClick={() => void loadPrCommits(pr.num, true)}
            className="flex-none rounded-md border border-amber-500/30 px-2 py-0.5 text-[11.5px] font-medium hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
          >
            Retry
          </button>
        </div>
      )}
      <div className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:divide-white/5 dark:border-white/10 dark:bg-neutral-800">
        {pr.commits.map((c) => (
          <CommitRow key={c.oid} commit={c} />
        ))}
      </div>
    </>
  );
}

function CommitRow({ commit }: { commit: PrCommitView }) {
  const showToast = useUi((s) => s.showToast);
  const [copied, setCopied] = useState(false);

  const copySha = () => {
    void navigator.clipboard?.writeText(commit.oid);
    showToast(`Copied ${commit.shortOid}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <span
        className={cn(
          "grid h-6 w-6 flex-none place-items-center rounded-md text-[10px] font-semibold",
          commit.hasAuthor
            ? "text-white"
            : "bg-black/[0.06] text-neutral-400 dark:bg-white/10",
        )}
        style={commit.hasAuthor ? { background: "var(--accent)" } : undefined}
      >
        {commit.author.initials}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] text-neutral-800 dark:text-neutral-100">
            {commit.headline}
          </span>
          {commit.verified && (
            <span
              title="Signature verified by GitHub"
              className="flex flex-none items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" className="h-3 w-3">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              Verified
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-neutral-400">
          <span className={cn("truncate", !commit.hasAuthor && "italic")}>{commit.author.name}</span>
          <span className="text-neutral-300 dark:text-neutral-600">·</span>
          <span className="flex-none">{commit.age}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={copySha}
        title={`Copy full SHA: ${commit.oid}`}
        className="flex flex-none items-center gap-1.5 rounded-md bg-black/[0.04] px-2 py-1 font-mono text-[11px] text-neutral-500 transition-colors hover:bg-black/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] dark:bg-white/[0.06] dark:text-neutral-400 dark:hover:bg-white/10"
      >
        {commit.shortOid}
        {copied ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3.5 w-3.5 text-emerald-500">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      {commit.url && (
        <button
          type="button"
          onClick={() => openExternalUrl(commit.url)}
          title="Open commit on GitHub"
          aria-label="Open commit on GitHub"
          className="grid h-7 w-7 flex-none place-items-center rounded-md text-neutral-400 transition-colors hover:bg-black/[0.05] hover:text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] dark:hover:bg-white/[0.08] dark:hover:text-neutral-200"
        >
          <GitHubIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
