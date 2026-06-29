import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import type { RepoSettingsSection } from "../../../store/ui";
import { IdCardIcon, RemotesIcon, RepoBookIcon, SettingsIcon } from "../../ui/icons";

const NAV: { key: RepoSettingsSection; label: string; Icon: typeof IdCardIcon }[] = [
  { key: "identity", label: "Identity", Icon: IdCardIcon },
  { key: "remotes", label: "Remotes", Icon: RemotesIcon },
];

/** Left rail of the Repository settings window: the repo header, the per-repo
 * sections (Identity, Remotes), and a link across to the global App settings. */
export const RepoSettingsSidebar = ({
  section,
  repoName,
  onSelect,
  onOpenGlobalSettings,
}: {
  section: RepoSettingsSection;
  repoName: string;
  onSelect: (section: RepoSettingsSection) => void;
  onOpenGlobalSettings: () => void;
}) => (
  <div className="flex w-[232px] flex-none flex-col border-r border-black/[0.06] bg-black/[0.015] dark:border-white/[0.07] dark:bg-black/20">
    <div className="flex items-center gap-3 px-5 pb-5 pt-6">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--accent-soft)] text-[color:var(--accent)]">
        <RepoBookIcon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <h1 className="text-[17px] font-bold leading-tight tracking-tight text-neutral-900 dark:text-white">
          Repository
        </h1>
        <div className="truncate font-mono text-[12px] text-neutral-400 dark:text-neutral-500">{repoName}</div>
      </div>
    </div>

    <div className="flex-1 overflow-y-auto px-3 pb-4">
      <div className="px-3 pb-1.5 pt-3 text-[11px] font-semibold tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
        THIS REPOSITORY
      </div>
      {NAV.map(({ key, label, Icon }) => {
        const active = section === key;
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "mb-0.5 flex h-10 w-full items-center gap-3 rounded-lg px-3 text-[14px] font-medium",
              active
                ? "bg-black/[0.06] text-neutral-900 dark:bg-white/[0.08] dark:text-white"
                : "text-neutral-500 hover:bg-black/[0.03] hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/[0.04] dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            <Icon className={cn("h-4 w-4 shrink-0", active ? "text-[color:var(--accent)]" : "text-neutral-400 dark:text-neutral-500")} />
            <span className="flex-1 text-left">{label}</span>
          </button>
        );
      })}

      <div className="px-3 pb-1.5 pt-5 text-[11px] font-semibold tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
        GLOBAL
      </div>
      <button
        onClick={onOpenGlobalSettings}
        className={cn(
          "group mb-0.5 flex h-10 w-full items-center gap-3 rounded-lg px-3 text-[14px] font-medium text-neutral-500 hover:bg-black/[0.03] hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/[0.04] dark:hover:text-neutral-200",
          focusRing,
        )}
      >
        <SettingsIcon className="h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" />
        <span className="flex-1 text-left">App settings</span>
        <span className="text-[15px] text-neutral-300 group-hover:text-neutral-400 dark:text-neutral-600 dark:group-hover:text-neutral-500">
          ↗
        </span>
      </button>
    </div>
  </div>
);
