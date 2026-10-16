// React root error hooks → the local frontend error log. React 19 calls
// `onCaughtError` for errors a boundary turned into a fallback and
// `onUncaughtError` for ones that unmounted the root; supplying either replaces
// React's own console report, so this keeps the console line too.

import { reportFrontendError, type FrontendErrorReport } from "@/lib/api";

/** Reports per kind per page load. A render loop can throw on every attempt; past this
 * the log already says what happened. */
const MAX_REPORTS = 20;

type Send = (report: FrontendErrorReport) => Promise<void>;

/** Returns a factory of root error handlers. Each kind has its own budget, so a
 * burst of contained errors can't crowd out the uncaught one that blanks the
 * window. */
export function createRenderErrorReporter(send: Send = reportFrontendError, max = MAX_REPORTS) {
  const sent = { caught: 0, uncaught: 0 };
  return (kind: FrontendErrorReport["kind"]) =>
    (error: unknown, info: { componentStack?: string }) => {
      console.error(error);
      if (sent[kind] >= max) return;
      sent[kind] += 1;
      const report: FrontendErrorReport = {
        kind,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? null) : null,
        componentStack: info.componentStack ?? null,
      };
      // A failed write must never raise a second error from the error path.
      void send(report).catch(() => {});
    };
}
