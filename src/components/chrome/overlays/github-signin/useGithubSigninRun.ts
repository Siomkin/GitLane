// Run state machine for the GitHub sign-in dialog: configure → running (ticking
// the checklist off `github-signin-progress` events, showing the one-time code)
// → done/error. A user Cancel kills the gh child and returns to configure — the
// device flow adds nothing until it's authorized, so a cancel is not a failure.

import { useRef, useState } from "react";
import { GITHUB_SIGNIN_PROGRESS, listenTyped, signInProgressSchema } from "@/lib/api";

import { friendlyGitError } from "@/lib/gitError";
import { useAccounts } from "@/store/accounts";
import { useStepRun } from "@/hooks/useStepRun";
import { useUi } from "@/store/ui";
import { signinStepIndex } from "./steps";

export type SigninPhase = "configure" | "running" | "done" | "error";

export interface SigninDone {
  host: string;
  login: string;
  /** Bindable account id, if the refreshed list resolved the new account. */
  accountId: string | null;
}

export interface GithubSigninRun {
  phase: SigninPhase;
  /** Furthest checklist row reached (only meaningful while running). */
  reached: number;
  /** One-time device code, once gh has printed it. */
  code: string | null;
  /** Verification URL gh opened (github.com/login/device). */
  url: string | null;
  /** Readable failure (error phase). */
  message: string;
  /** Resolved account (done phase). */
  done: SigninDone | null;
  /** Kick off sign-in for `host`. No-op while already running. */
  start: (host: string) => void;
  /** Cancel an in-flight sign-in (kills the gh child). */
  cancel: () => void;
}

export function useGithubSigninRun(): GithubSigninRun {
  const [phase, setPhase] = useState<SigninPhase>("configure");
  // -1 = before any milestone: every row is pending (the code box shows its own
  // "requesting…" spinner). Row 0 ("Code copied") only lights up once the code
  // actually arrives (`code` step → reached 1), so it can't spin prematurely.
  const [reached, setReached] = useState(-1);
  const [code, setCode] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState<SigninDone | null>(null);

  // The dialog body unmounts when the user closes it; guard against setState on
  // an unmounted component (the gh child is cancelled by the close handler).
  // The `mounted` guard, its StrictMode re-arm, the in-flight latch, and the
  // progress-event subscribe/unlisten wiring live in the shared run scaffold.
  const { mounted, start: startRun } = useStepRun();
  const canceled = useRef(false);

  const cancel = () => {
    canceled.current = true;
    void useAccounts.getState().cancelGithubSignIn();
    // Act immediately rather than waiting for the killed child's rejection to
    // land — the backend still reaps the gh child in the background.
    setPhase("configure");
  };

  const start = (host: string) => {
    // No-op while already running: `phase` is stale render state, so a fast
    // double-click could otherwise start two runs.
    const started = startRun(
      async () => {
        try {
          const result = await useAccounts.getState().signInGithub(host);
          // Refresh even on a cancel/close: a resolved sign-in means the account was
          // added to gh (the token persisted before any kill landed), so the list
          // must reflect it whichever screen we end on. Then resolve the account for
          // the "Use for this repo" offer. Only an exact login match may drive
          // the offer — falling back to e.g. the host's active account could bind
          // the wrong login when several exist on the host (the login is blank when
          // gh was reaped before printing "Logged in as").
          await useAccounts.getState().loadAccounts();
          const acc = result.login
            ? (useAccounts
                .getState()
                .accounts.find(
                  (a) =>
                    a.host === result.host && a.login.toLowerCase() === result.login.toLowerCase(),
                ) ?? null)
            : null;
          // A cancel/close that raced the authorization must not land on the
          // success screen — but the token was stored before the kill landed, so
          // the account exists now: say so instead of silently backing out.
          if (!mounted.current || canceled.current) {
            useUi
              .getState()
              .showToast(
                result.login
                  ? `Signed in as @${result.login} — the account was added.`
                  : "GitHub account added.",
              );
            return;
          }
          setDone({ host: result.host, login: result.login, accountId: acc?.id ?? null });
          setPhase("done");
        } catch (e) {
          if (!mounted.current) return;
          // A user-initiated cancel returns to configure — nothing was added.
          if (canceled.current) {
            setPhase("configure");
          } else {
            setMessage(friendlyGitError(e));
            setPhase("error");
          }
        }
      },
      // Subscribe before invoking so the earliest steps can't be missed.
      () =>
        listenTyped(
          GITHUB_SIGNIN_PROGRESS,
          signInProgressSchema,
          (payload) => {
            if (payload.step === "code") {
              if (payload.code) {
                setCode(payload.code);
                // Copy the code so it can be pasted straight into GitHub.
                try {
                  void navigator.clipboard?.writeText(payload.code);
                } catch {
                  /* clipboard unavailable — the code is shown for manual copy */
                }
              }
              if (payload.url) setUrl(payload.url);
            }
            const i = signinStepIndex(payload.step);
            // Monotonic: a stale/duplicate event never moves the checklist back.
            if (i >= 0) setReached((r) => Math.max(r, i));
          },
        ),
    );
    if (!started) return;
    canceled.current = false;
    setPhase("running");
    setReached(-1);
    setCode(null);
    setUrl(null);
    setMessage("");
  };

  return { phase, reached, code, url, message, done, start, cancel };
}
