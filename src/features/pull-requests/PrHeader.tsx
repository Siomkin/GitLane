// PR detail header: title, author/branch/state line, and the Info / Diff /
// Checks / Commits tab strip. Renders from whatever PR shape it's handed (list
// summary first, full detail once loaded).
import { cn } from "../../lib/cn";
import type { PullRequest } from "../../lib/prs";
import { useUi } from "../../store/ui";
import { PrHeaderActions } from "./PrActions";
import { stateView } from "./prState";

export function PrHeader({ pr }: { pr: PullRequest }) {
  const prTab = useUi((s) => s.prTab);
  const setPrTab = useUi((s) => s.setPrTab);
  const sv = stateView(pr);

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
        <PrHeaderActions pr={pr} />
      </div>
      <div className="mt-4 flex gap-5 border-b border-black/5 dark:border-white/5">
        <Tab label="Info" active={prTab === "info"} onClick={() => setPrTab("info")} />
        <Tab
          label="Diff"
          count={pr.files.length}
          active={prTab === "diff"}
          onClick={() => setPrTab("diff")}
        />
        <Tab label="Checks" active={prTab === "checks"} onClick={() => setPrTab("checks")} />
        <Tab
          label="Commits"
          count={pr.commits.length}
          active={prTab === "commits"}
          onClick={() => setPrTab("commits")}
        />
      </div>
    </div>
  );
}

function Tab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "mr-5 flex items-center gap-1.5 border-b-2 py-2 text-[13px] font-medium",
        active
          ? "border-[var(--accent)] text-neutral-800 dark:text-neutral-100"
          : "border-transparent text-neutral-500 dark:text-neutral-400",
      )}
    >
      {label}
      {count !== undefined && <span className="text-[11px] text-neutral-400">{count}</span>}
    </button>
  );
}
