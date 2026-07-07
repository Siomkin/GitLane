import { useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import type { RemoteInfo } from "../../../../lib/api";
import { CloudIcon, GitHubIcon, GitLabIcon, TrashIcon } from "../../../ui/icons";
import { detectRemoteUrl, prAbbr, prNoun, providerSupportsPrs, validateRemoteUrl } from "../../../../lib/remotes";
import { RemoteAccountPicker } from "./RemoteAccountPicker";
import type { PickerAccount } from "./remoteAccountOptions";
import type { ForgeAuthStatus } from "../../../../lib/api";
import { RemoteUrlField } from "./RemoteUrlField";
import { RemoteValidityLine } from "./RemoteValidityLine";

const URL_ROW = "flex items-center gap-2 text-[12.5px]";
const URL_KEY = "w-12 shrink-0 text-neutral-400 dark:text-neutral-500";
const URL_VAL = "truncate font-mono text-neutral-600 dark:text-neutral-300";

/** One configured remote: a card showing its name, provider + PR capability, and
 * fetch/push URLs, with inline edit (repoint URL) and a remove button. */
export const RemoteRow = ({
  remote,
  busy,
  accounts,
  forgeAuth,
  selectedAccountId,
  onPickAccount,
  onSave,
  onRemove,
}: {
  remote: RemoteInfo;
  busy: boolean;
  /** Connected accounts (host-filtered by the picker itself, GL-129). */
  accounts: PickerAccount[];
  forgeAuth: ForgeAuthStatus[];
  /** The account bound to this remote, or null for system git credentials. */
  selectedAccountId: string | null;
  onPickAccount: (remote: string, id: string | null) => void;
  /** Resolves true when the URL was saved; false keeps the row in edit mode. */
  onSave: (name: string, url: string) => Promise<boolean>;
  onRemove: (remote: RemoteInfo) => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(remote.fetchUrl);

  const info = detectRemoteUrl(remote.fetchUrl);
  const isGithub = info.provider === "github";
  const isGitlab = info.provider === "gitlab";
  const prs = providerSupportsPrs(info.provider);
  const validity = validateRemoteUrl(draft);

  const startEdit = () => {
    setDraft(remote.fetchUrl);
    setEditing(true);
  };

  return (
    <div className="rounded-xl border border-black/[0.07] bg-white p-4 dark:border-white/[0.08] dark:bg-neutral-800/50">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[14px] font-semibold text-neutral-900 dark:text-white">{remote.name}</span>
        {remote.isDefault && (
          <span className="grid h-5 place-items-center rounded bg-[var(--accent-soft)] px-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--accent)]">
            default
          </span>
        )}
        <span
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-md border border-black/10 px-2 text-[11.5px] font-medium dark:border-white/10",
            "bg-black/[0.03] text-neutral-600 dark:bg-white/[0.05] dark:text-neutral-300",
          )}
        >
          {isGithub ? (
            <GitHubIcon className="h-3.5 w-3.5" />
          ) : isGitlab ? (
            <GitLabIcon className="h-3.5 w-3.5" />
          ) : (
            <CloudIcon className="h-3.5 w-3.5" />
          )}
          {info.host ?? "unknown host"}
        </span>
        <span
          title={
            prs
              ? remote.isDefault
                ? `This remote drives ${prNoun(info.provider)} and ${prAbbr(info.provider)} auth — the bound account must match its host.`
                : `This provider supports ${prAbbr(info.provider)}s, but ${prNoun(info.provider)} follow the ${prAbbr(info.provider)} remote (the default).`
              : undefined
          }
          className={cn(
            "inline-flex h-6 items-center rounded-md px-2 text-[11.5px] font-medium",
            prs
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-black/[0.04] text-neutral-500 dark:bg-white/[0.06] dark:text-neutral-400",
          )}
        >
          {/* The default remote is what the PR tab and provider auth follow —
              name it, instead of the ambiguous "PRs on". GitLab speaks MRs. */}
          {prs
            ? isGitlab
              ? remote.isDefault
                ? "MR remote"
                : "MRs on"
              : remote.isDefault
                ? "PR remote"
                : "PRs on"
            : "No PRs"}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!editing && (
            <button
              type="button"
              disabled={busy}
              onClick={startEdit}
              className={cn(
                "h-8 rounded-lg px-3 text-[12.5px] font-medium text-neutral-600 hover:bg-black/5 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-white/10",
                focusRing,
              )}
            >
              Edit
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onRemove(remote)}
            title={`Remove ${remote.name}`}
            aria-label={`Remove remote ${remote.name}`}
            className={cn(
              "grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-40 dark:hover:text-rose-400",
              focusRing,
            )}
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!editing ? (
        <div className="mt-2.5 flex flex-col gap-1.5">
          <div className={URL_ROW}>
            <span className={URL_KEY}>fetch</span>
            <span className={URL_VAL}>{remote.fetchUrl || "—"}</span>
          </div>
          <div className={URL_ROW}>
            <span className={URL_KEY}>push</span>
            <span className={URL_VAL}>{remote.pushUrl || "—"}</span>
          </div>
          <RemoteAccountPicker
            remote={remote}
            accounts={accounts}
            forgeAuth={forgeAuth}
            selectedId={selectedAccountId}
            busy={busy}
            onPick={(id) => onPickAccount(remote.name, id)}
          />
        </div>
      ) : (
        <div className="mt-3">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
            Remote URL
          </span>
          <RemoteUrlField
            value={draft}
            onChange={setDraft}
            invalid={validity.level === "bad"}
            autoFocus
            ariaLabel={`URL for ${remote.name}`}
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <RemoteValidityLine validity={validity} />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="h-9 rounded-lg border border-black/10 px-3.5 text-[13px] font-semibold text-neutral-600 hover:bg-black/[0.04] dark:border-white/[0.14] dark:text-neutral-300 dark:hover:bg-white/[0.06]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!validity.ok || busy || draft.trim() === remote.fetchUrl}
                onClick={async () => {
                  if (await onSave(remote.name, draft.trim())) setEditing(false);
                }}
                className={cn(
                  "h-9 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40",
                  focusRing,
                )}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
