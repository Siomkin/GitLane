// The Access token method, the same three steps for every provider: create a
// token on the forge, what it needs (the caller's per-provider suggestions),
// then paste it — into GitLane's keychain or the user's own Git credential
// helper, by the user's choice. Only the storage choice is state here; the
// secret stays in the chosen form's own transient state.

import { useState } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { openExternalUrl } from "@/lib/openExternal";
import { ExternalLinkIcon } from "@/components/ui/icons";
import { linkCls } from "@/components/chrome/settings/accounts-panel/provider-connect/ui";
import type { Capability } from "./capabilities";
import { MethodPanel, mutedTextCls, strongTextCls } from "./MethodPanel";

export type TokenStorage = "keychain" | "helper";

const GCM_URL = "https://github.com/git-ecosystem/git-credential-manager#git-credential-manager";

export const linkButtonCls = cn(
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-black/10 px-3 text-[12px] font-medium text-neutral-800 transition hover:bg-black/[0.04] dark:border-white/[0.14] dark:text-neutral-100 dark:hover:bg-white/[0.06]",
  focusRing,
);

function Step({ n, title, current = false, children }: { n: number; title: string; current?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className={cn(
          "grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full text-[11px] font-bold",
          current
            ? "bg-[var(--accent)] text-white"
            : "bg-black/[0.06] text-neutral-800 dark:bg-white/[0.1] dark:text-neutral-100",
        )}
      >
        {n}
      </span>
      <div className="flex min-w-0 grow flex-col gap-2">
        <span className={cn("text-[12.5px]", strongTextCls)}>{title}</span>
        {children}
      </div>
    </li>
  );
}

/** One suggested token setting; `highlight` marks the one a refused push needs. */
export function Setting({ name, highlight = false, children }: { name: React.ReactNode; highlight?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn(highlight && "-mx-1.5 rounded-md bg-amber-500/10 px-1.5 py-1 ring-1 ring-amber-500/40")}>
      <div className={cn("flex items-center gap-1.5 text-[12.5px]", strongTextCls)}>
        {name}
        {highlight && (
          <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
            Needed to push
          </span>
        )}
      </div>
      <div className={mutedTextCls}>{children}</div>
    </div>
  );
}

export const mono = (text: string) => <span className="font-mono text-neutral-700 dark:text-neutral-200">{text}</span>;

const STORAGE_OPTIONS: { value: TokenStorage; label: string; hint: string }[] = [
  {
    value: "keychain",
    label: "GitLane, in your system keychain",
    hint: "GitLane feeds it to Git for this host, ahead of any credential your helpers saved.",
  },
  {
    value: "helper",
    label: "My Git credential helper",
    hint: "Shared with Git in your terminal. GitLane hands it over once and stores nothing.",
  },
];

function StoreIn({ value, onChange }: { value: TokenStorage; onChange: (value: TokenStorage) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className={cn("mb-1 text-[12px]", strongTextCls)}>Store in</legend>
      {STORAGE_OPTIONS.map((option) => (
        <label key={option.value} className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            name="token-storage"
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="mt-[3px] h-3.5 w-3.5 accent-[var(--accent)]"
          />
          <span className="flex flex-col">
            <span className="text-[12.5px] text-neutral-800 dark:text-neutral-100">
              {option.label}
              {option.value === "keychain" && (
                <span className="ml-1.5 rounded-full bg-[color:var(--accent)]/12 px-1.5 text-[10px] font-semibold text-[color:var(--accent)]">
                  Recommended
                </span>
              )}
            </span>
            <span className={mutedTextCls}>{option.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function AccessTokenMethod({
  forge,
  keychainSupported,
  capabilities,
  badge,
  createLinks,
  needs,
  keychainForm,
  helperForm,
  helperExtra,
}: {
  /** The forge's name, e.g. "GitLab". */
  forge: string;
  /** GitLane can own this provider's transport token (GitHub, GitLab, Bitbucket). */
  keychainSupported: boolean;
  capabilities: (storage: TokenStorage) => Capability[];
  badge?: { label: string; accent: boolean };
  /** Step 1: the forge's token page(s). */
  createLinks: React.ReactNode;
  /** Step 2: suggested settings — never the open repository's names. */
  needs: React.ReactNode;
  keychainForm?: React.ReactNode;
  helperForm: React.ReactNode;
  /** Shown under the helper form, e.g. the provider's HTTPS URL note. */
  helperExtra?: React.ReactNode;
}) {
  const [storage, setStorage] = useState<TokenStorage>(keychainSupported ? "keychain" : "helper");
  const stored = keychainSupported && storage === "keychain" ? "keychain" : "helper";
  return (
    <MethodPanel
      capabilities={capabilities(stored)}
      title="Access token"
      badge={badge}
      intro={`A token you create on ${forge} and paste here, used for clone, fetch, pull and push. It is not your ${forge} password.`}
    >
      <ol className="flex flex-col gap-4">
        <Step n={1} title={`Create a token on ${forge}`}>
          {createLinks}
        </Step>
        <Step n={2} title="What the token needs">
          {needs}
        </Step>
        <Step n={3} title="Paste it" current>
          {keychainSupported ? (
            <StoreIn value={storage} onChange={setStorage} />
          ) : (
            <p className={mutedTextCls}>
              GitLane keeps its own tokens for GitHub, GitLab and Bitbucket only, so your Git credential helper stores
              this one.
            </p>
          )}
          {stored === "keychain" ? (
            keychainForm
          ) : (
            <>
              <p className={mutedTextCls}>
                If your helper answers with an older saved credential, GitLane says which one and offers to forget it.
              </p>
              {helperForm}
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                <button type="button" onClick={() => openExternalUrl(GCM_URL)} className={linkCls}>
                  <ExternalLinkIcon className="h-3.5 w-3.5" />
                  Git Credential Manager
                </button>
              </div>
              {helperExtra}
            </>
          )}
        </Step>
      </ol>
    </MethodPanel>
  );
}
