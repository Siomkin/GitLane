// PR detail header: title, author/branch/state line, and the Info / Diff /
// Checks / Commits tab strip. Renders from whatever PR shape it's handed (list
// summary first, full detail once loaded).
import { cn } from "@/lib/cn";
import type { PrDetail, PrSummary } from "@/lib/prs";
import { usePulls } from "@/store/pulls";
import { useUi } from "@/store/ui";
import { PrHeaderActions } from "./PrActions";
import { checkProgressLabel, checkSummary, countChecks, type PrCheckTone } from "./prChecks";
import { stateView } from "./prState";

const checkBadgeToneClass: Record<PrCheckTone, string> = {
  pass: "text-emerald-600 dark:text-emerald-400",
  fail: "text-rose-600 dark:text-rose-400",
  pending: "text-amber-600 dark:text-amber-400",
  skipped: "text-neutral-500 dark:text-neutral-400",
  none: "text-neutral-400 dark:text-neutral-500",
};

export const PrHeader = ({ pr }: { pr: PrSummary | PrDetail }) => {
  const prTab = useUi((s) => s.prTab);
  const setPrTab = useUi((s) => s.setPrTab);
  const checks = usePulls((s) => s.prResources.checks.data[pr.num]);
  const checksLoading = usePulls((s) => !!s.prResources.checks.slots[pr.num]);
  const sv = stateView(pr);
  const checkCounts = checks ? countChecks(checks) : null;
  const checkSummaryView = checkCounts ? checkSummary(checkCounts) : null;
  const checkBadge =
    checkCounts != null
      ? checkProgressLabel(checkCounts)
      : prTab === "checks" && checksLoading
        ? "..."
        : undefined;

  return (
    <div className="flex-none px-6 pt-5">
      <h1 className="text-[22px] font-semibold leading-snug text-neutral-800 dark:text-neutral-100">
        <span className="mr-2 font-normal text-neutral-400 dark:text-neutral-500">#{pr.num}</span>
        {pr.title}
      </h1>
      <div className="mt-4 flex items-center gap-3">
        <span
          className="grid h-6 w-6 flex-none place-items-center rounded-md text-[10px] font-semibold text-white"
          style={{ background: "var(--accent)" }}
        >
          {pr.author.initials}
        </span>
        <span className="flex-none text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
          {pr.author.name}
        </span>
        <span className="flex h-6 min-w-0 flex-none items-center gap-1.5 rounded-md bg-black/[0.05] px-2 font-mono text-[11px] text-neutral-500 dark:bg-white/[0.06] dark:text-neutral-400">
          <span className="truncate">{pr.branch}</span>
          <span>→</span>
          <span className="truncate">{pr.base}</span>
        </span>
        <span className="flex-none text-[12px] text-neutral-400">{pr.age}</span>
        <span className={cn("flex flex-none items-center gap-1.5 text-[12px] font-medium", sv.text)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", sv.dot)} />
          {sv.label}
        </span>
        <PrHeaderActions key={pr.num} pr={pr} />
      </div>
      <div className="mt-4 flex gap-5 border-b border-black/5 dark:border-white/5">
        <Tab label="Info" active={prTab === "info"} onClick={() => setPrTab("info")} />
        <Tab
          label="Diff"
          // `changedFiles` (on every shape) — NOT `files.length`: during the
          // summary phase `files` doesn't exist and the old code read the
          // sentinel `[]` as a literal 0 badge while `changedFiles` held the
          // real count.
          count={pr.changedFiles}
          active={prTab === "diff"}
          onClick={() => setPrTab("diff")}
        />
        <Tab
          label="Checks"
          count={checkBadge}
          countTone={checkSummaryView?.tone}
          active={prTab === "checks"}
          onClick={() => setPrTab("checks")}
        />
        <Tab
          label="Commits"
          // Detail-only: no count until the detail lands (a summary has no
          // commit list, and a 0 badge would be a false claim).
          count={"commits" in pr ? pr.commits.length : undefined}
          active={prTab === "commits"}
          onClick={() => setPrTab("commits")}
        />
      </div>
    </div>
  );
};

const Tab = ({
  label,
  count,
  countTone,
  active,
  onClick,
}: {
  label: string;
  count?: number | string;
  countTone?: PrCheckTone;
  active: boolean;
  onClick: () => void;
}) => {
  return (
    <button type="button"
      onClick={onClick}
      className={cn(
        "mr-5 flex items-center gap-1.5 border-b-2 py-2 text-[13px] font-medium",
        active
          ? "border-[var(--accent)] text-neutral-800 dark:text-neutral-100"
          : "border-transparent text-neutral-500 dark:text-neutral-400",
      )}
    >
      {label}
      {count !== undefined && (
        <span className={cn("text-[11px] text-neutral-400", countTone && checkBadgeToneClass[countTone])}>
          {count}
        </span>
      )}
    </button>
  );
};
