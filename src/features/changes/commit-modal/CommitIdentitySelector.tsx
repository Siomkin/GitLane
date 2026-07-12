// Commit-dialog identity control (GL-213): shows the effective git author
// (name · email) and lets the user switch between "This computer" (global git
// config) and a saved identity card. Presentational — the identity view-model
// (load/apply state, effective identity, usability) lives in useCommitIdentity,
// owned by the commit modal. Reuses the settings picker's ProfileChoiceRow so the
// choices look identical to the Commit-author settings page.
//
// It sits on its own footer row so the full name · email is visible without
// truncation — the ticket requires the effective identity to be readable at a
// glance, and a card label alone is not enough.

import { useRef, useState } from "react";

import { Badge, HintBadges, ProfileChoiceRow } from "../../../components/chrome/settings/identity-panel/identityChoices";
import { GitBranchIcon } from "../../../components/ui/icons";
import { useDismiss } from "../../../hooks/useDismiss";
import { cn } from "../../../lib/cn";
import { profileInitials, signingLabel } from "../../../lib/profiles";
import { focusRing } from "../../../lib/ui";
import { type CommitIdentityModel } from "./useCommitIdentity";

export function CommitIdentitySelector({ identity }: { identity: CommitIdentityModel }) {
  const { loading, applying, error, usable, identityText, sourceLabel, selection, activeManual, manuals, defaultIdentity, apply } =
    identity;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  const choose = (target: { kind: "manual"; id: string } | null) => {
    setOpen(false);
    void apply(target);
  };

  return (
    <div className="flex w-full min-w-0 items-center gap-2.5" aria-live="polite">
      <div ref={ref} className="relative min-w-0 flex-1">
        <button
          type="button"
          aria-label={`Commit identity: ${applying ? "Applying identity…" : identityText}`}
          aria-haspopup="true"
          aria-expanded={open}
          disabled={loading || applying}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-1 text-left",
            usable
              ? "border-black/10 hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.04]"
              : "border-amber-500/40 bg-amber-500/[0.06]",
            focusRing,
          )}
        >
          {activeManual ? (
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px] font-bold text-white"
              style={{ background: activeManual.color }}
              aria-hidden
            >
              {profileInitials(activeManual.label)}
            </span>
          ) : (
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-black/[0.06] text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300" aria-hidden>
              <GitBranchIcon className="h-3.5 w-3.5" />
            </span>
          )}
          <span
            className={cn(
              "min-w-0 flex-1 break-words text-[12.5px] leading-tight",
              usable ? "text-neutral-700 dark:text-neutral-200" : "text-amber-700 dark:text-amber-300",
            )}
          >
            {applying ? "Applying identity…" : identityText}
          </span>
          <span className="shrink-0 text-[11.5px] font-medium text-neutral-400 dark:text-neutral-500">Change</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {open && (
          <div
            role="group"
            aria-label={`Commit identity choices — ${sourceLabel}`}
            className="absolute bottom-full left-0 z-[80] mb-2 max-h-[320px] w-[min(520px,calc(100vw-4rem))] space-y-2 overflow-auto rounded-xl border border-black/10 bg-white p-2 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)] dark:border-white/10 dark:bg-neutral-800"
          >
            <ProfileChoiceRow
              title="Default git identity"
              subtitle={
                defaultIdentity
                  ? `${defaultIdentity.name || "No name set"} · ${defaultIdentity.email || "No email set"}`
                  : "No global git identity configured"
              }
              icon={<GitBranchIcon className="h-[18px] w-[18px]" />}
              active={selection.kind === "computer"}
              badges={<Badge>GLOBAL CONFIG</Badge>}
              onClick={() => (selection.kind === "computer" ? setOpen(false) : choose(null))}
            />
            {manuals.map((p) => {
              const active = selection.kind === "manual" && selection.id === p.id;
              const sign = signingLabel(p);
              return (
                <ProfileChoiceRow
                  key={p.id}
                  title={p.label}
                  subtitle={`${p.name || "No name set"} · ${p.email || "No email set"}`}
                  swatch={p.color}
                  active={active}
                  badges={
                    <>
                      {p.isDefault && <Badge tone="amber">Suggested</Badge>}
                      {sign && <Badge>{sign}</Badge>}
                      {active && <HintBadges selection={selection} />}
                    </>
                  }
                  onClick={() => (active ? setOpen(false) : choose({ kind: "manual", id: p.id }))}
                />
              );
            })}
          </div>
        )}
      </div>
      {error && <span className="shrink-0 text-[11.5px] text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}
