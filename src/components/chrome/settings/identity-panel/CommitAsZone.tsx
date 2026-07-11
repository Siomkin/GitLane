// The repo's commit identity selector: pick the git profile written to this
// repo's local git config. The profile list is the picker; a separate
// unmanaged callout appears only when the current repo config does not match a
// saved profile or this computer's global git identity.

import { useState, type ReactNode } from "react";

import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { useRepo } from "../../../../store/repo";
import { useAccounts } from "../../../../store/accounts";
import { appliedCommitSource, useIdentities } from "../../../../store/identities";
import { selectCommitSource } from "../../../../lib/identities";
import { profileInitials, type GitProfile } from "../../../../lib/profiles";
import { useUi } from "../../../../store/ui";
import { ArrowUpRightIcon, GitBranchIcon, UserIcon } from "../../../ui/icons";

export function CommitAsZone() {
  const [picking, setPicking] = useState(false);
  const summary = useRepo((s) => s.summary);
  const repoIdentity = useAccounts((s) => s.repoIdentity);
  const manuals = useIdentities((s) => s.manualIdentities);
  const defaultIdentity = useIdentities((s) => s.defaultIdentity);
  const applyCommitSource = useIdentities((s) => s.applyCommitSource);
  const closeRepoSettings = useUi((s) => s.closeRepoSettings);
  const openIdentitiesSettings = useUi((s) => s.openIdentitiesSettings);

  if (!summary) return null;

  const selection = selectCommitSource(repoIdentity, manuals, appliedCommitSource(), defaultIdentity);
  // What the repo currently commits as: the local pin, else the global config.
  const effectiveName = repoIdentity?.name ?? defaultIdentity?.name ?? "";
  const effectiveEmail = repoIdentity?.email ?? defaultIdentity?.email ?? "";
  const selectedManual =
    selection.kind === "manual" ? manuals.find((p) => p.id === selection.id) ?? null : null;

  const adoptAsIdentity = () => {
    if (!repoIdentity) return;
    closeRepoSettings();
    openIdentitiesSettings({
      kind: "new",
      prefill: {
        name: repoIdentity.name,
        email: repoIdentity.email,
        signingKey: repoIdentity.signingKey,
        gpgFormat:
          repoIdentity.gpgFormat === "ssh"
            ? "ssh"
            : repoIdentity.gpgFormat === "openpgp"
              ? "openpgp"
              : undefined,
        gpgSign: repoIdentity.gpgSign,
        tagGpgSign: repoIdentity.tagGpgSign,
      },
    });
  };

  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[11px] font-semibold tracking-[0.08em] text-neutral-500 dark:text-neutral-400">
          COMMIT AS · GIT IDENTITY
        </div>
        <button type="button"
          onClick={() => {
            closeRepoSettings();
            openIdentitiesSettings();
          }}
          className={cn(
            "inline-flex items-center gap-1 text-[11.5px] font-semibold text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300",
            focusRing,
          )}
        >
          Manage identities
          <ArrowUpRightIcon className="h-3 w-3" />
        </button>
      </div>
      <p className="mt-1.5 text-[12.5px] text-neutral-500 dark:text-neutral-400">
        The name &amp; email written to this repo's local git config — who shows up in{" "}
        <span className="font-mono text-[12px]">git log</span>.
      </p>

      {picking ? (
        <div
          className="mt-3 space-y-2 rounded-xl border border-black/[0.07] bg-black/[0.02] p-2 dark:border-white/[0.08] dark:bg-white/[0.03]"
          role="group"
          aria-label="Git identity choices"
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
            onClick={() => {
              if (selection.kind !== "computer") void applyCommitSource(null);
              setPicking(false);
            }}
          />
          {manuals.map((p) => {
            const active = selection.kind === "manual" && selection.id === p.id;
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
                    {signingLabel(p) && <Badge>{signingLabel(p)}</Badge>}
                    {active && <HintBadges selection={selection} />}
                  </>
                }
                onClick={() => {
                  if (!active) void applyCommitSource({ kind: "manual", id: p.id });
                  setPicking(false);
                }}
              />
            );
          })}
        </div>
      ) : selection.kind === "unmanaged" ? (
        <>
          <UnmanagedIdentityCard
            name={effectiveName}
            email={effectiveEmail}
            signed={Boolean(repoIdentity?.gpgSign || repoIdentity?.tagGpgSign)}
            onSave={adoptAsIdentity}
            onClear={() => void applyCommitSource(null)}
          />
          <button type="button"
            onClick={() => setPicking(true)}
            className={cn(
              "mt-2 text-[12px] font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            Choose a different identity...
          </button>
        </>
      ) : (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-black/[0.07] bg-black/[0.02] p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
          {selectedManual ? (
            <span
              className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-[11px] font-bold text-white"
              style={{ background: selectedManual.color }}
              aria-hidden
            >
              {profileInitials(selectedManual.label)}
            </span>
          ) : (
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-black/[0.06] text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
              <GitBranchIcon className="h-[18px] w-[18px]" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">
                {selectedManual ? selectedManual.label : "Default git identity"}
              </span>
              {selectedManual ? (
                <>
                  {selectedManual.isDefault && <Badge tone="amber">Suggested</Badge>}
                  {signingLabel(selectedManual) && <Badge>{signingLabel(selectedManual)}</Badge>}
                  <HintBadges selection={selection} />
                </>
              ) : (
                <Badge>GLOBAL CONFIG</Badge>
              )}
            </div>
            <div className="mt-0.5 truncate font-mono text-[12px] text-neutral-500 dark:text-neutral-400">
              {selectedManual
                ? `${selectedManual.name || "No name set"} · ${selectedManual.email || "No email set"}`
                : defaultIdentity
                  ? `${defaultIdentity.name || "No name set"} · ${defaultIdentity.email || "No email set"}`
                  : "No global git identity configured"}
            </div>
          </div>
          <button type="button"
            onClick={() => setPicking(true)}
            className={cn(
              "h-8 shrink-0 rounded-lg px-3 text-[12.5px] font-medium text-neutral-500 transition hover:bg-black/[0.06] hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            Change
          </button>
        </div>
      )}
    </div>
  );
}

/** The hint-line badges: which card the current name/email match, plus how
 * they diverge from its saved values. Purely informational. */
function HintBadges({
  selection,
}: {
  selection: ReturnType<typeof selectCommitSource>;
}) {
  if (selection.kind === "manual") {
    return (
      <>
        {selection.customName &&
          <Badge title="The author name differs from this profile's saved name — names are free-form; attribution follows the email.">
            custom name
          </Badge>}
        {selection.customSigning && <Badge tone="amber">custom signing</Badge>}
      </>
    );
  }
  return null;
}

function UnmanagedIdentityCard({
  name,
  email,
  signed,
  onSave,
  onClear,
}: {
  name: string;
  email: string;
  signed: boolean;
  onSave: () => void;
  onClear: () => void;
}) {
  return (
    <div className="mt-3 rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3.5">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
          <UserIcon className="h-[19px] w-[19px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">
              Unmanaged local identity
            </span>
            {signed && <Badge>signed</Badge>}
          </div>
          <div className="mt-0.5 truncate font-mono text-[12px] text-neutral-600 dark:text-neutral-300">
            {name || "No name set"} · {email || "No email set"}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button"
              onClick={onSave}
              className={cn(
                "inline-flex h-8 items-center rounded-lg bg-emerald-600 px-3 text-[12.5px] font-semibold text-white hover:bg-emerald-500",
                focusRing,
              )}
            >
              Save as profile
            </button>
            <button type="button"
              onClick={onClear}
              className={cn(
                "inline-flex h-8 items-center rounded-lg border border-black/10 px-3 text-[12.5px] font-semibold text-neutral-700 hover:bg-black/[0.04] dark:border-white/15 dark:text-neutral-200 dark:hover:bg-white/[0.06]",
                focusRing,
              )}
            >
              Clear &amp; use default
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileChoiceRow({
  title,
  subtitle,
  active,
  icon,
  swatch,
  badges,
  onClick,
}: {
  title: string;
  subtitle: string;
  active: boolean;
  icon?: ReactNode;
  swatch?: string;
  badges?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={title}
      className={cn(
        "flex w-full items-center gap-3 rounded-[10px] border p-3 text-left transition",
        active
          ? "border-[color:var(--accent)]/45 bg-[var(--accent-soft)]"
          : "border-black/[0.06] bg-black/[0.02] hover:bg-black/[0.04] dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:bg-white/[0.06]",
        focusRing,
      )}
    >
      <span
        className={cn(
          "grid h-4 w-4 shrink-0 place-items-center rounded-full border",
          active
            ? "border-[color:var(--accent)]"
            : "border-neutral-400/70 dark:border-neutral-500/80",
        )}
        aria-hidden
      >
        {active && <span className="h-2 w-2 rounded-full bg-[color:var(--accent)]" />}
      </span>
      {swatch ? (
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-[11px] font-bold text-white"
          style={{ background: swatch }}
          aria-hidden
        >
          {profileInitials(title)}
        </span>
      ) : (
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-black/[0.06] text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">{title}</span>
          {badges}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[12px] text-neutral-500 dark:text-neutral-400">
          {subtitle}
        </span>
      </span>
    </button>
  );
}

function signingLabel(profile: GitProfile): string | null {
  if (!profile.signingKey || (!profile.gpgSign && !profile.tagGpgSign)) return null;
  return profile.gpgFormat === "ssh" ? "SSH signed" : "GPG signed";
}

function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "amber";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[17px] items-center gap-1 rounded-full px-1.5 text-[10px] font-semibold",
        tone === "accent"
          ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
          : tone === "amber"
            ? "bg-amber-500/12 text-amber-600 dark:text-amber-400"
            : "bg-black/[0.05] text-neutral-500 dark:bg-white/[0.07] dark:text-neutral-400",
      )}
    >
      {children}
    </span>
  );
}
