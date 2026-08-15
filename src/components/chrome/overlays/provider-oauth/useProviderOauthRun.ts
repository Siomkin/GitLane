// Run state machine for the native provider OAuth dialog (GL-139): configure →
// running (ticking the checklist off `provider-oauth-progress` events, showing
// the device code for GitLab / opening the authorize page for Bitbucket) →
// done/error. Mirrors the GitHub sign-in hook; a user Cancel discards the codes
// and returns to configure — a cancel is not a failure.

import { useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";

import { friendlyGitError } from "@/lib/gitError";
import { openExternalUrl } from "@/lib/openExternal";
import type { ProviderOauthProgress } from "@/lib/api";
import { useAccounts } from "@/store/accounts";
import { useStepRun } from "@/hooks/useStepRun";
import { useUi, type ProviderOauthSigninRequest } from "@/store/ui";
import { oauthModeFor, oauthStepIndex } from "./steps";

export type OauthPhase = "configure" | "running" | "done" | "error";

export interface ProviderOauthDone {
  provider: string;
  host: string;
  login: string;
  /** The remote pinned to this account on success, if any. */
  boundRemote?: string;
}

export interface ProviderOauthRun {
  phase: OauthPhase;
  /** A sign-in lifecycle still owns the app-global backend flow. */
  busy: boolean;
  /** Furthest checklist row reached (only meaningful while running). */
  reached: number;
  /** One-time device code (device flow), once the backend has requested it. */
  code: string | null;
  /** Verification / authorize URL the backend produced. */
  url: string | null;
  /** Readable failure (error phase). */
  message: string;
  /** Resolved account (done phase). */
  done: ProviderOauthDone | null;
  /** Kick off the sign-in. No-op while already running. */
  start: () => void;
  /** Cancel an in-flight sign-in (discards the codes). */
  cancel: () => void;
}

// The backend OAuth flow is app-global, and a dialog can unmount/reopen while a
// canceled run is still compensating its committed credential. Keep one owner
// across hook instances until that rollback has finished, so a retry can never
// race the previous run's token deletion / remote un-pin.
let activeProviderOauthRun: symbol | null = null;
const providerOauthRunListeners = new Set<() => void>();

const providerOauthRunBusy = () => activeProviderOauthRun !== null;

const subscribeProviderOauthRun = (listener: () => void) => {
  providerOauthRunListeners.add(listener);
  return () => {
    providerOauthRunListeners.delete(listener);
  };
};

const setActiveProviderOauthRun = (owner: symbol | null) => {
  activeProviderOauthRun = owner;
  for (const listener of providerOauthRunListeners) listener();
};

export function useProviderOauthRun(req: ProviderOauthSigninRequest): ProviderOauthRun {
  const mode = oauthModeFor(req.provider);
  const busy = useSyncExternalStore(
    subscribeProviderOauthRun,
    providerOauthRunBusy,
    providerOauthRunBusy,
  );
  const [phase, setPhase] = useState<OauthPhase>("configure");
  const [reached, setReached] = useState(-1);
  const [code, setCode] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState<ProviderOauthDone | null>(null);

  // Guard setState after the dialog closes (the backend flow is cancelled by the
  // close handler). The `mounted` guard, its StrictMode re-arm, and the
  // in-flight latch live in the shared run scaffold; unlike the other run
  // hooks, this one keeps its own progress-event wiring inside the body (see
  // `start`) so a listener failure releases the app-global owner.
  const { mounted, inFlight, start: startRun } = useStepRun();
  const canceled = useRef(false);
  const cancelDecision = useRef<Promise<boolean> | null>(null);
  const opened = useRef(false);
  // The remote's account before this flow pins to it — snapshotted at start so a
  // late cancel can restore it (the pin is reverted, not left dangling).
  const priorRemoteUsername = useRef<string | null>(null);

  const cancel = () => {
    if (!inFlight.current || cancelDecision.current) return;
    const decision = useAccounts
      .getState()
      .cancelProviderOauthSignIn()
      .then(() => true)
      .catch((e) => {
        useUi
          .getState()
          .showToast(
            friendlyGitError(String(e instanceof Error ? e.message : e)),
            "error",
          );
        return false;
      });
    cancelDecision.current = decision;
    void decision.then((accepted) => {
      if (!accepted) return;
      canceled.current = true;
      if (mounted.current) setPhase("configure");
    });
  };

  const start = () => {
    // The app-global owner latch stops a second flow while one is still
    // running (including another dialog instance); the scaffold's latch stops
    // a fast double-click on this instance. Checked in that order so the
    // owner claim below can never race this instance's own latch.
    if (inFlight.current || activeProviderOauthRun) return;
    const runOwner = Symbol("provider-oauth-run");
    const started = startRun(
      async () => {
        // Subscribe before invoking so the earliest steps can't be missed. It
        // stays inside this try — not in the scaffold's `subscribe` slot — so a
        // listener failure still reaches the catch below (an error screen
        // instead of a dialog stuck on "running") and, crucially, the finally
        // that releases the app-global owner. Out there it would skip both and
        // wedge every later sign-in.
        let unlisten: (() => void) | null = null;
        try {
          unlisten = await listen<ProviderOauthProgress>(
            "provider-oauth-progress",
            ({ payload }) => {
              if (payload.provider !== req.provider) return; // ignore a stray flow
              if (payload.userCode) {
                setCode(payload.userCode);
                try {
                  void navigator.clipboard?.writeText(payload.userCode);
                } catch {
                  /* clipboard unavailable — the code is shown for manual copy */
                }
              }
              if (payload.verificationUri) {
                setUrl(payload.verificationUri);
                // Open the verification/authorize page for the user, once.
                if (!opened.current) {
                  opened.current = true;
                  openExternalUrl(payload.verificationUri);
                }
              }
              const i = oauthStepIndex(mode, payload.step);
              if (i >= 0) setReached((r) => Math.max(r, i));
            },
          );
          const result = await useAccounts
            .getState()
            .signInProviderOauth(req.provider, req.host, req.remote);
          if (cancelDecision.current) await cancelDecision.current;
          if (canceled.current) {
            // Late cancel: the flow finished and persisted a keychain token (and,
            // for a bound remote, pinned it into the remote URL) before the cancel
            // registered — roll all of it back so cancel means "no account added"
            // and the remote keeps its prior account.
            await useAccounts
              .getState()
              .rollbackProviderOauthSignIn(
                req.provider,
                result,
                req.remote,
                priorRemoteUsername.current,
              );
            if (mounted.current) setPhase("configure");
            return;
          }
          if (!mounted.current) {
            // Not an exception to "routine success is silent": the dialog that
            // would have shown "Signed in as …" was dismissed while the flow was
            // in the browser, so the toast is the only surface left (same shape
            // as the handoff fallback in `useHandoffRun`).
            useUi.getState().showToast(`Signed in as @${result.login} on ${result.host}.`);
            return;
          }
          setDone({
            provider: result.provider,
            host: result.host,
            login: result.login,
            boundRemote: req.remote,
          });
          setPhase("done");
        } catch (e) {
          const raw = String(e instanceof Error ? e.message : e);
          if (cancelDecision.current) await cancelDecision.current;
          if (!mounted.current) return;
          if (canceled.current) setPhase("configure");
          else {
            setMessage(friendlyGitError(raw));
            setPhase("error");
          }
        } finally {
          unlisten?.();
          // Release the app-global owner so a retry can never race the previous
          // run's rollback (the scaffold unlatches right after).
          if (activeProviderOauthRun === runOwner) setActiveProviderOauthRun(null);
        }
      },
    );
    if (!started) return;
    setActiveProviderOauthRun(runOwner);
    canceled.current = false;
    cancelDecision.current = null;
    opened.current = false;
    // Snapshot the remote's current account before the flow pins to it.
    priorRemoteUsername.current = req.remote
      ? useAccounts.getState().remoteUrlUsername(req.remote)
      : null;
    setPhase("running");
    setReached(-1);
    setCode(null);
    setUrl(null);
    setMessage("");
  };

  return { phase, busy, reached, code, url, message, done, start, cancel };
}
