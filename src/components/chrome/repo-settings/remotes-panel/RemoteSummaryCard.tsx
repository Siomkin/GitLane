import { cn } from "../../../../lib/cn";
import type { RemoteInfo } from "../../../../lib/api";
import { CloudIcon, GitHubIcon } from "../../../ui/icons";
import { detectRemoteUrl, providerSupportsPrs } from "../../../../lib/remotes";

/** Headline card for the default push remote — its host, the remote name, PR
 * capability, and the bound PR account (when one is set). */
export const RemoteSummaryCard = ({
  remote,
  accountLabel,
}: {
  remote: RemoteInfo;
  accountLabel: string | null;
}) => {
  const info = detectRemoteUrl(remote.fetchUrl);
  const isGithub = info.provider === "github";
  const prs = providerSupportsPrs(info.provider);

  return (
    <div className="flex items-center gap-3.5 rounded-xl border border-black/[0.07] bg-white p-4 dark:border-white/[0.08] dark:bg-neutral-800/60">
      <span className="grid h-10 w-10 place-items-center rounded-lg bg-black/[0.04] text-neutral-700 dark:bg-white/[0.06] dark:text-neutral-200">
        {isGithub ? <GitHubIcon className="h-5 w-5" /> : <CloudIcon className="h-5 w-5" />}
      </span>
      <div className="min-w-0">
        <div className="text-[14px] font-semibold text-neutral-900 dark:text-white">
          {info.host ?? "Unknown host"}
        </div>
        <div className="text-[12.5px] text-neutral-500 dark:text-neutral-400">
          Default push remote · <span className="font-mono">{remote.name}</span>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-[12px] font-medium",
            prs ? "text-emerald-600 dark:text-emerald-400" : "text-neutral-500 dark:text-neutral-400",
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", prs ? "bg-emerald-500" : "bg-neutral-400")} />
          {prs ? "Pull requests enabled" : "Pull requests unavailable"}
        </span>
        {accountLabel && (
          <span className="text-[12.5px] text-neutral-500 dark:text-neutral-400">
            Account <span className="font-medium text-neutral-700 dark:text-neutral-200">{accountLabel}</span>
          </span>
        )}
      </div>
    </div>
  );
};
