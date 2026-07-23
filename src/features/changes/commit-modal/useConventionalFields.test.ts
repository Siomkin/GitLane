import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useConventionalFields } from "./useConventionalFields";

/** Drive the hook the way its owners do: the composed message feeds straight
 * back in as the next `message` prop (store-backed in the inline composer,
 * local state in the reword dialog). */
function renderControlled(initial: string) {
  let message = initial;
  const setMessage = vi.fn((next: string) => {
    message = next;
  });
  const view = renderHook(() => useConventionalFields(message, setMessage));
  return { ...view, setMessage, current: () => view.result.current };
}

describe("useConventionalFields", () => {
  it("parses the initial message into fields", () => {
    const { result } = renderHook(() =>
      useConventionalFields("fix(ui): keep the message\n\nExplain why.", vi.fn()),
    );

    expect(result.current.fields).toEqual({
      type: "fix",
      scope: "ui",
      subject: "keep the message",
      body: "Explain why.",
    });
  });

  it("composes field edits back into the message", () => {
    const { current, setMessage } = renderControlled("fix(ui): keep the message");

    act(() => current().updateFields({ subject: "improve the editor" }));

    expect(setMessage).toHaveBeenCalledWith("fix(ui): improve the editor");
    expect(current().fields.subject).toBe("improve the editor");
  });

  it("does not re-parse a message it composed itself", () => {
    // A trailing space survives in the fields but is trimmed out of the
    // composed subject line — so a stray re-parse would eat it mid-typing.
    const { current, rerender } = renderControlled("fix(ui): keep the message");

    act(() => current().updateFields({ subject: "keep typing " }));
    rerender();

    expect(current().fields.subject).toBe("keep typing ");
  });

  it("re-parses an externally changed message", () => {
    let message = "fix(ui): keep the message";
    const { result, rerender } = renderHook(() =>
      useConventionalFields(message, vi.fn()),
    );

    // An agent draft landing / the post-commit clear / an amend prefill.
    message = "feat(api): add the endpoint\n\nWhy it matters.";
    rerender();

    expect(result.current.fields).toEqual({
      type: "feat",
      scope: "api",
      subject: "add the endpoint",
      body: "Why it matters.",
    });
  });

  it("writes the message once per field edit under StrictMode", () => {
    // The compose side effects live in the handler, not inside the setFields
    // updater — StrictMode double-invokes updaters, so a regression there
    // would fire setMessage twice.
    const setMessage = vi.fn();
    const { result } = renderHook(
      () => useConventionalFields("fix: a subject", setMessage),
      { wrapper: StrictMode },
    );

    act(() => result.current.updateFields({ subject: "another subject" }));

    expect(setMessage).toHaveBeenCalledTimes(1);
    expect(setMessage).toHaveBeenCalledWith("fix: another subject");
  });
});
