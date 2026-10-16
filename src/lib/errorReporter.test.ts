import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRenderErrorReporter } from "./errorReporter";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createRenderErrorReporter", () => {
  it("maps an Error and its component stack to a report", () => {
    const send = vi.fn(() => Promise.resolve());
    const error = new Error("boom");

    createRenderErrorReporter(send)("uncaught")(error, { componentStack: "\n    at Dialog" });

    expect(send).toHaveBeenCalledWith({
      kind: "uncaught",
      message: "boom",
      stack: error.stack,
      componentStack: "\n    at Dialog",
    });
    expect(console.error).toHaveBeenCalledWith(error);
  });

  it("reports a non-Error throw by its string form", () => {
    const send = vi.fn(() => Promise.resolve());

    createRenderErrorReporter(send)("caught")("plain", {});

    expect(send).toHaveBeenCalledWith({
      kind: "caught",
      message: "plain",
      stack: null,
      componentStack: null,
    });
  });

  it("stops sending after the per-load budget, across both kinds", () => {
    const send = vi.fn(() => Promise.resolve());
    const report = createRenderErrorReporter(send, 3);

    for (let i = 0; i < 4; i++) report("caught")(new Error(`e${i}`), {});
    report("uncaught")(new Error("late"), {});

    expect(send).toHaveBeenCalledTimes(3);
  });

  it("swallows a failed send", async () => {
    const send = vi.fn(() => Promise.reject(new Error("ipc down")));

    expect(() => createRenderErrorReporter(send)("uncaught")(new Error("boom"), {})).not.toThrow();
    await Promise.resolve();
  });
});
