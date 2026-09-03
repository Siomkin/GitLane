import { describe, it, expect, beforeEach, vi } from "vitest";

// `listenTyped` wraps `@tauri-apps/api/event`'s `listen`; the mock captures the
// callback it registers so a test can drive one event payload through it.
const listenMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import {
  DELETE_WORKTREE_PROGRESS,
  deleteWorktreeProgressEventSchema,
  listenTyped,
  PTY_DATA,
  ptyDataEventSchema,
  REPO_CHANGED,
  repoChangedEventSchema,
} from "./events";
import { IpcValidationError } from "./validate";

type Emit = (payload: unknown) => void;

/** Register a listener through the mock and return the callback Tauri would
 *  invoke, shaped like a real `Event<unknown>`. */
async function subscribe<T>(
  name: string,
  schema: Parameters<typeof listenTyped<T>>[1],
  handler: (payload: T) => void,
): Promise<Emit> {
  let callback: ((event: { event: string; id: number; payload: unknown }) => void) | undefined;
  listenMock.mockImplementationOnce((_name: string, cb: typeof callback) => {
    callback = cb;
    return Promise.resolve(() => {});
  });
  await listenTyped(name, schema, handler);
  if (!callback) throw new Error("listen was not called");
  const fire = callback;
  return (payload: unknown) => fire({ event: name, id: 1, payload });
}

beforeEach(() => listenMock.mockReset());

describe("listenTyped", () => {
  it("subscribes under the declared name and returns the unlisten fn", async () => {
    const off = () => {};
    listenMock.mockResolvedValueOnce(off);
    await expect(listenTyped(REPO_CHANGED, repoChangedEventSchema, () => {})).resolves.toBe(off);
    expect(listenMock).toHaveBeenCalledWith(REPO_CHANGED, expect.any(Function));
  });

  it("forwards a valid payload, parsed, to the handler", async () => {
    const handler = vi.fn();
    const emit = await subscribe(REPO_CHANGED, repoChangedEventSchema, handler);
    emit({ kind: "graph", path: "/repo" });
    expect(handler).toHaveBeenCalledWith({ kind: "graph", path: "/repo" });
  });

  it("throws IpcValidationError naming the event and field, and never calls the handler", async () => {
    const handler = vi.fn();
    const emit = await subscribe(
      DELETE_WORKTREE_PROGRESS,
      deleteWorktreeProgressEventSchema,
      handler,
    );
    // The spec's case: a progress payload that lost its `step` field must not
    // advance the checklist, and must not be silently ignored either.
    expect(() => emit({})).toThrow(IpcValidationError);
    expect(() => emit({})).toThrow(/delete-worktree-progress/);
    expect(() => emit({})).toThrow(/step/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a payload whose field has the wrong type", async () => {
    const handler = vi.fn();
    const emit = await subscribe(REPO_CHANGED, repoChangedEventSchema, handler);
    expect(() => emit({ kind: "worktree", path: 7 })).toThrow(IpcValidationError);
    expect(() => emit({ kind: "elsewhere", path: "/repo" })).toThrow(IpcValidationError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("checks the pty byte array for shape without validating every byte", async () => {
    const handler = vi.fn();
    const emit = await subscribe(PTY_DATA, ptyDataEventSchema, handler);
    emit({ sessionId: 3, data: [104, 105] });
    expect(handler).toHaveBeenCalledWith({ sessionId: 3, data: [104, 105] });
    expect(() => emit({ sessionId: 3, data: "hi" })).toThrow(IpcValidationError);
  });

  it("strips unknown fields rather than rejecting them (forward compat)", async () => {
    const handler = vi.fn();
    const emit = await subscribe(REPO_CHANGED, repoChangedEventSchema, handler);
    emit({ kind: "worktree", path: "/repo", addedByANewerBackend: true });
    expect(handler).toHaveBeenCalledWith({ kind: "worktree", path: "/repo" });
  });
});
