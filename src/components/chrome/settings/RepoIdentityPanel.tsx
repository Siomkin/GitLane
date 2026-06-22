// Repository Identity settings: which account this repo fetches/pushes/opens PRs
// as, and the commit identity (name + email) stamped on every commit. The commit
// editor is a one-off, so it stays co-located; its validation rules live in the
// pure `identity.ts` helpers. All async writes go through the accounts store.

import { useEffect, useId, useState } from "react";
import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import { useRepo } from "../../../store/repo";
import { useAccounts, type RepoIdentity } from "../../../store/accounts";
import { SectionLabel } from "./controls";
import { isIdentityDirty, isIdentityValid } from "./identity";

export function RepoIdentityPanel() {
  const summary = useRepo((s) => s.summary);
  const accounts = useAccounts((s) => s.accounts);
  const repoAccountId = useAccounts((s) => s.repoAccountId);
  const setRepoAccount = useAccounts((s) => s.setRepoAccount);
  const repoIdentity = useAccounts((s) => s.repoIdentity);
  const repoName = (summary?.workdir ?? summary?.path ?? "—").replace(/\/$/, "").split("/").pop();

  const options = [
    { id: null as string | null, username: "No identity (read-only)", label: "Use the repo / global git config", initials: "—", color: "" },
    ...accounts.map((a) => ({
      id: a.id as string | null,
      username: `@${a.username}`,
      label: `${a.name} · ${a.email || a.host}`,
      initials: a.username.slice(0, 2).toUpperCase(),
      color: a.color,
    })),
  ];

  if (!summary) {
    return (
      <>
        <div className="mb-1 text-[19px] font-bold text-neutral-800 dark:text-neutral-100">Identity</div>
        <div className="rounded-xl border border-black/10 bg-black/[0.03] p-5 text-[13px] text-neutral-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-400">
          Open a repository to choose the account it commits, fetches, and pushes as.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mb-1 text-[19px] font-bold text-neutral-800 dark:text-neutral-100">Identity</div>
      <div className="mb-[18px] text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Identity for <span className="font-semibold text-neutral-800 dark:text-neutral-100">{repoName}</span>. The commit
        identity below is stamped on <span className="font-semibold text-neutral-800 dark:text-neutral-100">every commit</span>{" "}
        (author + committer), overriding global git config so another tool can&apos;t change who you
        commit as.
      </div>

      <SectionLabel>ACCOUNT — FETCH, PUSH &amp; PULL REQUESTS</SectionLabel>
      <div role="radiogroup" aria-label="Account used for fetch, push and pull requests">
        {options.map((option) => {
          const selected = repoAccountId === option.id;
          return (
            <button
              key={option.id ?? "none"}
              role="radio"
              aria-checked={selected}
              onClick={() => void setRepoAccount(option.id)}
              className={cn(
                "mb-1.5 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5",
                focusRing,
              )}
            >
              <span
                className={cn(
                  "h-[18px] w-[18px] flex-none rounded-full border-2",
                  selected
                    ? "border-[color:var(--accent)] bg-[var(--accent)]"
                    : "border-black/20 dark:border-white/20",
                )}
              />
              <span
                className={cn(
                  "grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] text-[13px] font-bold",
                  option.id
                    ? "text-white"
                    : "bg-black/[0.05] text-neutral-500 dark:bg-white/[0.06]",
                )}
                style={option.id ? { background: option.color } : undefined}
              >
                {option.initials}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{option.username}</div>
                {option.label && <div className="text-[11.5px] text-neutral-400">{option.label}</div>}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-7">
        <SectionLabel>COMMIT IDENTITY</SectionLabel>
        <CommitIdentityEditor key={repoAccountId ?? "none"} identity={repoIdentity} />
      </div>
    </>
  );
}

function CommitIdentityEditor({ identity }: { identity: RepoIdentity | null }) {
  const editRepoIdentity = useAccounts((s) => s.editRepoIdentity);
  const [name, setName] = useState(identity?.name ?? "");
  const [email, setEmail] = useState(identity?.email ?? "");
  const nameId = useId();
  const emailId = useId();

  // Resync when the bound account changes (prefills) or another save lands.
  useEffect(() => {
    setName(identity?.name ?? "");
    setEmail(identity?.email ?? "");
  }, [identity?.name, identity?.email]);

  const dirty = isIdentityDirty(name, email, identity);
  const valid = isIdentityValid(name, email);

  return (
    <div className="rounded-xl border border-black/10 bg-black/[0.03] p-4 dark:border-white/10 dark:bg-white/[0.04]">
      <label htmlFor={nameId} className="mb-1 block text-[11px] font-semibold tracking-[0.04em] text-neutral-400">
        NAME
      </label>
      <input
        id={nameId}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your Name"
        className="mb-3 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-[13.5px] text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
      />
      <label htmlFor={emailId} className="mb-1 block text-[11px] font-semibold tracking-[0.04em] text-neutral-400">
        EMAIL
      </label>
      <input
        id={emailId}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="mb-3.5 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-[13.5px] text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
      />
      <div className="flex items-center gap-3">
        <button
          disabled={!dirty || !valid}
          onClick={() => void editRepoIdentity(name, email)}
          className={cn(
            "rounded-lg px-4 py-2.5 text-[13px] font-medium",
            dirty && valid
              ? "bg-[var(--accent)] text-white transition hover:brightness-110"
              : "cursor-default bg-black/[0.05] text-neutral-400 dark:bg-white/[0.06]",
            focusRing,
          )}
        >
          Save identity
        </button>
        {!identity && (
          <span className="text-[11.5px] text-neutral-400">
            No identity pinned — commits use git config.
          </span>
        )}
        {identity && !dirty && <span className="text-[11.5px] text-emerald-500">Saved ✓</span>}
      </div>
    </div>
  );
}
