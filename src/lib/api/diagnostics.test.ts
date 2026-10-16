import { describe, it, expect, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { reportFrontendError } from "./diagnostics";

describe("reportFrontendError", () => {
  it("sends the report under `report` to report_frontend_error", async () => {
    const report = {
      kind: "uncaught" as const,
      message: "boom",
      stack: "Error: boom",
      componentStack: "\n    at Dialog",
    };

    await reportFrontendError(report);

    expect(invokeMock).toHaveBeenCalledWith("report_frontend_error", { report });
  });
});
