// Inline commit identity control (GL-213, commit panel redesign): a static
// avatar + name/email row where only the "Change" link is interactive — the
// row itself is plain text, per the design. Presentational — the identity
// view-model (load/apply state, effective identity, usability) lives in
// useCommitIdentity, owned by the commit composer. Reuses the settings
// picker's ProfileChoiceRow so the choices look identical to the
// Commit-author settings page.

import { Badge, HintBadges, ProfileChoiceRow } from "@/components/chrome/settings/identity-panel/identityChoices";
import { GitBranchIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { profileInitials, signingLabel } from "@/lib/profiles";
import { focusRing } from "@/lib/ui";
import { type CommitIdentityModel } from "./useCommitIdentity";
import { useFixedPopover } from "@/features/changes/useFixedPopover";

export function CommitIdentitySelector({ identity }: { identity: CommitIdentityModel }) {
  const { loading, applying, error, usable, effective, identityText, sourceLabel, selection, activeManual, manuals, defaultIdentity, apply } =
    identity;
  const { ref, menuRef, open, menuStyle, toggle, close, portal } = useFixedPopover();

  const choose = (target: { kind: "manual"; id: string } | null) => {
    close();
    void apply(target);
  };

  return (
    <div className="flex w-full min-w-0 items-center gap-2.5" aria-live="polite">
      <div ref={ref} className="flex min-w-0 flex-1 items-center gap-2.5">
        {activeManual ? (
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white"
            style={{ background: activeManual.color }}
            aria-hidden
          >
            {profileInitials(activeManual.label)}
          </span>
        ) : effective?.name?.trim() ? (
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-[10px] font-semibold text-white" aria-hidden>
            {profileInitials(effective.name)}
          </span>
        ) : (
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-black/[0.06] text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300" aria-hidden>
            <GitBranchIcon className="h-3.5 w-3.5" />
          </span>
        )}
        <div className="min-w-0 flex-1 leading-tight">
          {applying ? (
            <div className="truncate text-[12.5px] font-medium text-neutral-700 dark:text-neutral-200">
              Applying identity…
            </div>
          ) : effective ? (
            <>
              <div
                className={cn(
                  "truncate text-[12.5px] font-medium",
                  usable ? "text-neutral-700 dark:text-neutral-200" : "text-amber-700 dark:text-amber-300",
                )}
                title={effective.name || undefined}
              >
                {effective.name || "No name set"}
              </div>
              <div className="truncate font-mono text-[11px] text-neutral-400" title={effective.email || undefined}>
                {effective.email || "No email set"}
              </div>
            </>
          ) : (
            <div className="text-[12.5px] leading-tight text-amber-700 dark:text-amber-300">{identityText}</div>
          )}
        </div>
        <button
          type="button"
          aria-label={`Commit identity: ${applying ? "Applying identity…" : identityText}`}
          aria-haspopup="true"
          aria-expanded={open}
          disabled={loading || applying}
          onClick={toggle}
          className={cn(
            "shrink-0 text-[11.5px] font-medium text-neutral-400 hover:text-neutral-600 disabled:cursor-not-allowed disabled:opacity-45 dark:text-neutral-500 dark:hover:text-neutral-300",
            focusRing,
          )}
        >
          Change
        </button>

        {portal(() => (
          <div
            ref={menuRef}
            role="group"
            aria-label={`Commit identity choices — ${sourceLabel}`}
            style={menuStyle}
            className="fixed z-[80] max-h-[320px] w-[min(520px,calc(100vw-4rem))] space-y-2 overflow-auto rounded-xl border border-black/10 bg-white p-2 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)] dark:border-white/10 dark:bg-neutral-800"
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
              onClick={() => (selection.kind === "computer" ? close() : choose(null))}
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
                  onClick={() => (active ? close() : choose({ kind: "manual", id: p.id }))}
                />
              );
            })}
          </div>
        ))}
      </div>
      {error && <span className="shrink-0 text-[11.5px] text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}
