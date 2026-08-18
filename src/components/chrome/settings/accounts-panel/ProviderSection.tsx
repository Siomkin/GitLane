// One provider's group on the Accounts page: a brand-marked header (icon + name
// + a capability chip) over a bordered container of that provider's account rows.
// Grouping by provider is what makes each row's provider unambiguous — the rows
// themselves no longer repeat the forge name.

import type { ReactNode } from "react";
import type { ProviderKey } from "./providers";
import { AzureDevOpsIcon, BitbucketIcon, CursorOriginIcon, GitHubIcon, GitLabIcon } from "@/components/ui/icons";
import { ForgeKind } from "@/lib/api";

type IconProps = { className?: string };

const META: Record<string, { name: string; Icon: (p: IconProps) => ReactNode }> = {
  github: { name: "GitHub", Icon: GitHubIcon },
  gitlab: { name: "GitLab", Icon: GitLabIcon },
  bitbucket: { name: "Bitbucket", Icon: BitbucketIcon },
  [ForgeKind.CursorOrigin]: { name: "Cursor Origin", Icon: CursorOriginIcon },
  "azure-devops": { name: "Azure DevOps", Icon: AzureDevOpsIcon },
};

/** The provider's pull/merge-request capability, shown once per section instead
 * of on every row. `pr` = enabled (green), `warn` = transport-only/attention
 * (amber), `muted` = neutral. */
export type Capability = { label: string; tone: "pr" | "warn" | "muted" } | null;

function CapabilityChip({ label, tone }: NonNullable<Capability>) {
  if (tone === "pr") {
    return (
      <span className="inline-flex h-[18px] items-center gap-1.5 rounded-full bg-emerald-500/12 px-2 text-[10.5px] font-semibold text-emerald-600 dark:text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {label}
      </span>
    );
  }
  if (tone === "warn") {
    return (
      <span className="inline-flex h-[18px] items-center rounded-full bg-amber-500/12 px-2 text-[10.5px] font-semibold text-amber-600 dark:text-amber-400">
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex h-[18px] items-center rounded-full bg-black/[0.05] px-2 text-[10.5px] font-semibold text-neutral-500 dark:bg-white/[0.07] dark:text-neutral-400">
      {label}
    </span>
  );
}

export function ProviderSection({
  provider,
  capability,
  children,
}: {
  provider: ProviderKey;
  capability: Capability;
  children: ReactNode;
}) {
  const meta = META[provider] ?? { name: provider, Icon: () => null };
  const Icon = meta.Icon;
  return (
    <div>
      <div className="flex items-center gap-2.5 px-0.5 pb-2">
        <span className="text-neutral-500 dark:text-neutral-300">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span className="text-[14px] font-semibold text-neutral-900 dark:text-white">{meta.name}</span>
        {capability && <CapabilityChip {...capability} />}
      </div>
      <div className="divide-y divide-black/[0.06] overflow-hidden rounded-xl border border-black/[0.07] bg-black/[0.02] dark:divide-white/[0.07] dark:border-white/[0.08] dark:bg-white/[0.03]">
        {children}
      </div>
    </div>
  );
}
