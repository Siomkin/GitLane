import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { CommandError, invoke, isCommandError, toCommandError } from "./invoke";
import type { CommandErrorPayload } from "./git/types/error";

// Isolation runs in `afterEach`, not `beforeEach`: with any `beforeEach` on this
// mock, vitest 4.1 reports the transport's *rejected* results as unhandled
// rejections against the `invoke wrapper` tests even though the wrapper
// converted them (verified: the same file passes with the hook moved here).
afterEach(() => invokeMock.mockClear());

describe("toCommandError", () => {
  it("wraps the raw IPC payload, keeping every optional field", () => {
    const payload: CommandErrorPayload = {
      kind: "hookRejected",
      message: "✖ subject may not be empty",
      detail: "yarn run v1\n✖ subject may not be empty\nhusky - commit-msg script failed",
      hook: "commit-msg",
      code: undefined,
    };
    const err = toCommandError(payload);
    expect(err).toBeInstanceOf(CommandError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CommandError");
    expect(err.kind).toBe("hookRejected");
    expect(err.message).toBe(payload.message);
    expect(err.detail).toBe(payload.detail);
    expect(err.hook).toBe("commit-msg");
    expect(err.code).toBeUndefined();
    expect(err.path).toBeUndefined();
  });

  it("keeps code and path for classified auth / missing-path rejections", () => {
    const auth = toCommandError({ kind: "auth", code: "sshPublickey", message: "denied" });
    expect(auth.kind).toBe("auth");
    expect(auth.code).toBe("sshPublickey");
    const gone = toCommandError({ kind: "missingPath", message: "gone", path: "/repo" });
    expect(gone.kind).toBe("missingPath");
    expect(gone.path).toBe("/repo");
  });

  it("passes an existing CommandError through by identity", () => {
    const err = new CommandError({ kind: "git", message: "boom" });
    expect(toCommandError(err)).toBe(err);
  });

  it("degrades a payload with an unknown kind to internal, preserving the message", () => {
    const err = toCommandError({ kind: "missing", message: "old shape", path: "/x" });
    expect(err.kind).toBe("internal");
    expect(err.message).toBe("old shape");
    expect(err.path).toBeUndefined();
  });

  it("turns an Error into an internal CommandError carrying its message", () => {
    const err = toCommandError(new Error("plain failure"));
    expect(err.kind).toBe("internal");
    expect(err.message).toBe("plain failure");
  });

  it("turns a string into an internal CommandError", () => {
    const err = toCommandError("fatal: something");
    expect(err.kind).toBe("internal");
    expect(err.message).toBe("fatal: something");
  });

  it("stringifies junk (numbers, objects without a message, undefined)", () => {
    expect(toCommandError(42).message).toBe("42");
    expect(toCommandError(undefined).message).toBe("undefined");
    expect(toCommandError({ kind: "git" }).kind).toBe("internal");
    expect(toCommandError({ code: "x", message: "no kind" }).kind).toBe("internal");
    expect(toCommandError(null).message).toBe("null");
  });

  it("ignores non-string optional fields on a payload", () => {
    const err = toCommandError({ kind: "git", message: "m", code: 7, hook: null });
    expect(err.code).toBeUndefined();
    expect(err.hook).toBeUndefined();
  });
});

describe("CommandError", () => {
  it("stringifies to the bare message so legacy String(e) sites read unchanged", () => {
    const err = new CommandError({ kind: "git", message: "error: pathspec 'x' did not match" });
    expect(String(err)).toBe("error: pathspec 'x' did not match");
    expect(`${err}`).toBe("error: pathspec 'x' did not match");
    expect(err.toString()).not.toContain("CommandError");
  });

  it("is recognised by isCommandError, including a same-shaped Error from another module instance", () => {
    expect(isCommandError(new CommandError({ kind: "git", message: "m" }))).toBe(true);
    const foreign = Object.assign(new Error("m"), { name: "CommandError", kind: "git" });
    expect(isCommandError(foreign)).toBe(true);
    expect(isCommandError(new Error("m"))).toBe(false);
    expect(isCommandError({ kind: "git", message: "m" })).toBe(false);
    expect(isCommandError("git")).toBe(false);
  });
});

describe("invoke wrapper", () => {
  it("forwards the command and args and resolves with the raw result", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    await expect(invoke("open_repo", { path: "/r" })).resolves.toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith("open_repo", { path: "/r" });
  });

  it("rethrows a payload rejection as a CommandError", async () => {
    invokeMock.mockRejectedValue({ kind: "indexLock", message: "index.lock exists" });
    const err = await invoke("stage_files", {}).catch((e: unknown) => e);
    expect(isCommandError(err)).toBe(true);
    expect((err as CommandError).kind).toBe("indexLock");
    expect((err as CommandError).message).toBe("index.lock exists");
  });

  it("rethrows a string rejection as an internal CommandError", async () => {
    invokeMock.mockRejectedValue("legacy string");
    await expect(invoke("list_stashes")).rejects.toMatchObject({ kind: "internal", message: "legacy string" });
    await expect(invoke("list_stashes")).rejects.toThrow("legacy string");
  });

  it("converts a synchronous throw from the transport too", async () => {
    invokeMock.mockImplementation(() => {
      throw new Error("sync boom");
    });
    await expect(invoke("list_stashes")).rejects.toMatchObject({ kind: "internal", message: "sync boom" });
  });
});
