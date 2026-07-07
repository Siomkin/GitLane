// Run state machine for the native provider OAuth dialog (GL-139): configure →
// running (ticking the checklist off `provider-oauth-progress` events, showing
// the device code for GitLab / opening the authorize page for Bitbucket) →
// done/error. Mirrors the GitHub sign-in hook; a user Cancel discards the codes
// and returns to configure — a cancel is not a failure.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { friendlyGitError } from "@/lib/gitError";
import { openExternalUrl } from "@/lib/openExternal";
import type { ProviderOauthProgress } from "@/lib/api";
import { useAccounts } from "@/store/accounts";
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

export function useProviderOauthRun(req: ProviderOauthSigninRequest): ProviderOauthRun {
  const mode = oauthModeFor(req.provider);
  const [phase, setPhase] = useState<OauthPhase>("configure");
  const [reached, setReached] = useState(-1);
  const [code, setCode] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState<ProviderOauthDone | null>(null);

  // Guard setState after the dialog closes (the backend flow is cancelled by the
  // close handler). Re-arm on mount so StrictMode's dev double-mount can't leave
  // `mounted` permanently false on the real instance.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const inFlight = useRef(false);
  const canceled = useRef(false);
  const opened = useRef(false);
  // The remote's account before this flow pins to it — snapshotted at start so a
  // late cancel can restore it (the pin is reverted, not left dangling).
  const priorRemoteUsername = useRef<string | null>(null);

  const cancel = () => {
    canceled.current = true;
    void useAccounts.getState().cancelProviderOauthSignIn();
    setPhase("configure");
  };

  const start = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    canceled.current = false;
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
    void (async () => {
      // Subscribe before invoking so the earliest steps can't be missed.
      const unlisten = await listen<ProviderOauthProgress>(
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
      try {
        const result = await useAccounts
          .getState()
          .signInProviderOauth(req.provider, req.host, req.remote);
        if (canceled.current) {
          // Late cancel: the flow finished and persisted a keychain token (and,
          // for a bound remote, pinned it into the remote URL) before the cancel
          // registered — roll all of it back so cancel means "no account added"
          // and the remote keeps its prior account.
          void useAccounts
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
        if (!mounted.current) return;
        if (canceled.current) setPhase("configure");
        else {
          setMessage(friendlyGitError(raw));
          setPhase("error");
        }
      } finally {
        inFlight.current = false;
        unlisten();
      }
    })();
  };

  return { phase, reached, code, url, message, done, start, cancel };
}
