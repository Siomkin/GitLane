// Raw IPC for the frontend error log (`report_frontend_error`). Rust redacts and
// appends each report to a size-capped file in the app-log directory; the
// React root's error hooks are the only caller (lib/errorReporter.ts).

import { invoke } from "@/lib/api/invoke";

/** Mirrors the Rust `FrontendErrorReport`. `caught` means an error boundary
 * showed a fallback; `uncaught` means React unmounted the root. */
export interface FrontendErrorReport {
  kind: "caught" | "uncaught";
  message: string;
  stack: string | null;
  componentStack: string | null;
}

/** Append one render error to the local frontend error log. */
export const reportFrontendError = (report: FrontendErrorReport): Promise<void> =>
  invoke("report_frontend_error", { report });
