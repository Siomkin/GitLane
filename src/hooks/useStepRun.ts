import { useEffect, useRef } from "react";

/**
 * The lifecycle scaffold shared by the overlay "run" hooks (hand-off,
 * delete-worktree, remove-detached, GitHub sign-in, provider OAuth): the
 * `mounted` guard with its StrictMode re-arm effect, the synchronous
 * in-flight latch, and — for runs that report progress over Tauri events —
 * the subscribe-before-invoke / unlisten-on-exit wiring. The run bodies are
 * genuinely different and stay in each hook; this is only the scaffold.
 */
export function useStepRun() {
  // Guard setState after the dialog body unmounts (the run keeps going in the
  // background and reports via toast). The effect body must re-arm the flag:
  // under StrictMode's dev double-mount the cleanup runs once on the simulated
  // unmount, and a cleanup-only effect would leave `mounted` permanently false
  // on the real, visible instance.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Synchronous in-flight latch: `phase` is stale render state, so a fast
  // double-click could start two runs before the re-render lands.
  const inFlight = useRef(false);

  /**
   * Launch one run. No-op (returns `false`) while a run started through this
   * hook instance is still in flight. `subscribe`, when given, is awaited
   * before the body so the earliest progress events can't be missed; its
   * unlisten fn is called — and the latch released — in the finally, whatever
   * the body does (including a `subscribe` that itself rejects). With a
   * `subscribe`, the body first runs after it resolves; callers keep their
   * post-latch sync work (state resets, store latches) after a `true` return,
   * in the same tick as before.
   */
  const start = (
    body: () => Promise<void>,
    subscribe?: () => Promise<() => void>,
  ): boolean => {
    if (inFlight.current) return false;
    inFlight.current = true;
    void (async () => {
      let unlisten: (() => void) | null = null;
      try {
        if (subscribe) unlisten = await subscribe();
        await body();
      } catch {
        // The run body owns its error surface (phase/toast) — every current
        // caller catches its own IPC failures. This only stops a bug in a
        // body's error path from wedging the latch or spawning an unhandled
        // rejection; the lifecycle guarantees below still run.
      } finally {
        unlisten?.();
        inFlight.current = false;
      }
    })();
    return true;
  };

  return { mounted, inFlight, start };
}
