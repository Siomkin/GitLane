// Native OAuth sign-in for a supported forge (GL-139), rendered as the *body* of
// a MethodCard (the card supplies the "Sign in with OAuth" title + frame).
// Register an app with the forge and paste its *public* client id; GitLane then
// authorizes in the browser and stores the token in the OS keychain. When no
// client id is registered this collapses to a quiet "Set up OAuth" affordance
// with the exact registration checklist.

import { useEffect, useState } from "react";
import { cn } from "../../../../../lib/cn";
import { focusRing } from "../../../../../lib/ui";
import { openExternalUrl } from "../../../../../lib/openExternal";
import type { ForgeAuthProvider } from "../../../../../lib/api";
import { useUi } from "../../../../../store/ui";
import { useAccounts } from "../../../../../store/accounts";
import { DEFAULT_CREDENTIAL_HOST, supportsEditableOauthHost } from "../../../../../lib/forgeHelp";
import { OAUTH_HELP } from "./oauth";
import { ExternalIcon, inputCls, linkCls } from "./ui";

interface OauthStatus {
  configured: boolean;
  source: string;
}

interface KeyedOauthStatus extends OauthStatus {
  key: string;
}

export function OauthMethod({ provider, forge }: { provider: ForgeAuthProvider; forge: string }) {
  const openProviderOauthSignin = useUi((s) => s.openProviderOauthSignin);
  const oauthClientStatus = useAccounts((s) => s.oauthClientStatus);
  const setOauthClientIdAction = useAccounts((s) => s.setOauthClientId);
  const defaultHost = DEFAULT_CREDENTIAL_HOST[provider] ?? "";
  // Only GitLab supports self-managed hosts; Bitbucket OAuth is Cloud-only, so its
  // host is always bitbucket.org and there is nothing to enter.
  const allowHostEdit = supportsEditableOauthHost(provider);
  const [host, setHost] = useState(defaultHost);
  const [statusResult, setStatusResult] = useState<KeyedOauthStatus | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [clientId, setClientId] = useState("");
  const [saving, setSaving] = useState(false);
  const probeHost = host.trim() || defaultHost;
  const statusKey = `${provider}\u0000${probeHost}`;
  const status: OauthStatus | null =
    statusResult?.key === statusKey
      ? { configured: statusResult.configured, source: statusResult.source }
      : null;

  const probe = (h: string, key = `${provider}\u0000${h}`) => {
    Promise.resolve(oauthClientStatus(provider, h))
      .then((s) =>
        setStatusResult({
          key,
          ...(s ? { configured: s.configured, source: s.source } : { configured: false, source: "none" }),
        }),
      )
      .catch(() => setStatusResult({ key, configured: false, source: "none" }));
  };
  useEffect(() => {
    let alive = true;
    Promise.resolve(oauthClientStatus(provider, probeHost))
      .then((s) => {
        if (!alive) return;
        setStatusResult({
          key: statusKey,
          ...(s ? { configured: s.configured, source: s.source } : { configured: false, source: "none" }),
        });
      })
      .catch(() => {
        if (alive) setStatusResult({ key: statusKey, configured: false, source: "none" });
      });
    return () => {
      alive = false;
    };
  }, [oauthClientStatus, probeHost, provider, statusKey]);

  const help = OAUTH_HELP[provider];
  if (!help) return null;

  const save = async () => {
    const h = host.trim();
    if (!h) return;
    setSaving(true);
    try {
      await setOauthClientIdAction(provider, h, clientId.trim());
      setClientId("");
      setShowConfig(false);
      probe(h);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  // A user-set override can be cleared by saving an empty field; a fresh, empty
  // form has nothing to save, so the button stays disabled rather than offering a
  // confusing "Clear" on first setup.
  const hasOverride = status?.source === "override";
  const clearing = clientId.trim() === "";
  const saveDisabled = saving || host.trim() === "" || (clearing && !hasOverride);
  const saveLabel = clearing && hasOverride ? "Clear client id" : "Save client id";
  const effectiveHost = host.trim() || defaultHost;

  return (
    <>
      {status?.configured ? (
        <>
          <p className="text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            Authorize GitLane on <span className="font-mono">{effectiveHost}</span> in your browser — the token is saved
            to your OS keychain and used for push and fetch. Nothing else to set up.
          </p>
          <div className="mt-2.5 flex items-center gap-3">
            <button
              type="button"
              onClick={() => openProviderOauthSignin({ provider, host: effectiveHost })}
              className={cn(
                "inline-flex h-9 items-center rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white transition hover:brightness-110",
                focusRing,
              )}
            >
              Sign in with OAuth
            </button>
            <button
              type="button"
              onClick={() => setShowConfig((v) => !v)}
              className="text-[11.5px] font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
            >
              {showConfig ? "Hide" : "Manage client id"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            {status === null ? (
              "Checking for a registered OAuth app…"
            ) : (
              <>
                Sign in without a token by registering a {forge} {help.consumer} for{" "}
                <span className="font-mono">{effectiveHost}</span> and pasting its public id here.
              </>
            )}
          </p>
          <button
            type="button"
            onClick={() => setShowConfig((v) => !v)}
            className="mt-2 block text-[11.5px] font-semibold text-[color:var(--accent)] hover:underline"
          >
            {showConfig ? "Hide OAuth setup" : "Set up OAuth"}
          </button>
        </>
      )}

      {showConfig && (
        <div className="mt-2.5 rounded-lg border border-black/[0.06] bg-black/[0.015] p-3 dark:border-white/[0.07] dark:bg-white/[0.02]">
          <p className="text-[11.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            A {help.consumer}'s{" "}
            <span className="font-semibold text-neutral-600 dark:text-neutral-300">{help.idTerm}</span> is a public id —
            not a secret — that lets GitLane sign in on your behalf. GitLane ships none by default; register your own (a
            company can register one app and share its {help.idTerm}).
          </p>
          <p className="mt-2.5 text-[11.5px] font-semibold text-neutral-600 dark:text-neutral-300">
            In {forge} → {help.where}, set:
          </p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {help.settings.map((s) => (
              <li
                key={s.label}
                className="flex gap-1.5 text-[11.5px] leading-relaxed text-neutral-500 dark:text-neutral-400"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mt-[3px] h-3 w-3 shrink-0 text-[color:var(--accent)]"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span>
                  <span className="font-semibold text-neutral-600 dark:text-neutral-300">{s.label}:</span> {s.value}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">{help.note}</p>
          <button
            type="button"
            onClick={() => openExternalUrl(help.createUrl(effectiveHost))}
            className={cn(linkCls, "mt-2.5")}
          >
            <ExternalIcon />
            {help.createLabel}
          </button>
          <div className="mt-2.5 flex flex-col gap-2">
            {allowHostEdit && (
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="Host (e.g. gitlab.example.com)"
                spellCheck={false}
                className={inputCls}
              />
            )}
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={`${forge} ${help.idTerm} for ${effectiveHost}`}
              spellCheck={false}
              className={inputCls}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={saveDisabled}
                onClick={() => void save()}
                className={cn(
                  "h-9 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white disabled:opacity-40",
                  focusRing,
                )}
              >
                {saveLabel}
              </button>
              {hasOverride && (
                <span className="text-[11px] text-emerald-600 dark:text-emerald-400">Saved for {effectiveHost}</span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
