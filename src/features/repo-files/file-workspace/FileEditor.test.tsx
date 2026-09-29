import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Language } from "@/lib/highlight";
import { isMac } from "@/lib/platform";
import { FileEditor } from "./FileEditor";

const mod = isMac ? { metaKey: true } : { ctrlKey: true };
const otherMod = isMac ? { ctrlKey: true } : { metaKey: true };

const renderEditor = (onSave: () => void) =>
  render(
    <FileEditor
      draft="edited"
      dirty
      saving={false}
      error={null}
      lang={Language.Generic}
      baseline={null}
      onChange={() => {}}
      onSave={onSave}
    />,
  );

describe("FileEditor save shortcut", () => {
  it("saves by physical key on a non-Latin layout", () => {
    const onSave = vi.fn();
    renderEditor(onSave);
    // Russian layout: the S key reports `key: "ы"`, `code: "KeyS"`.
    fireEvent.keyDown(window, { ...mod, code: "KeyS", key: "ы" });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("ignores the other platform's modifier", () => {
    const onSave = vi.fn();
    renderEditor(onSave);
    fireEvent.keyDown(window, { ...otherMod, code: "KeyS", key: "s" });
    expect(onSave).not.toHaveBeenCalled();
  });
});
