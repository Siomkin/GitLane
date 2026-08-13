import { describe, expect, it } from "vitest";
import { DEFAULT_COMMIT_AGENT_MESSAGES } from "@/store/commitAgentMessages";
import {
  addAiActionCommand,
  aiActionsValid,
  isBuiltinAiAction,
  moveAiActionCommand,
  removeAiActionCommand,
  persistableAiActions,
  resetBuiltinAiAction,
  updateAiActionCommand,
} from "./aiActionDraft";

const shipped = DEFAULT_COMMIT_AGENT_MESSAGES.aiActions;

describe("aiActionDraft", () => {
  it("treats the six shipped ids as builtins", () => {
    expect(isBuiltinAiAction("short")).toBe(true);
    expect(isBuiltinAiAction("impl")).toBe(true);
    expect(isBuiltinAiAction("custom")).toBe(false);
  });

  it("adds a blank enabled command and refuses to delete a builtin", () => {
    const withMine = addAiActionCommand(shipped);
    expect(withMine).toHaveLength(7);
    expect(withMine[6]?.title).toBe("");
    expect(withMine[6]?.enabled).toBe(true);
    expect(removeAiActionCommand(withMine, "short")).toHaveLength(7);
    expect(removeAiActionCommand(withMine, withMine[6]!.id)).toHaveLength(6);
  });

  it("reorders, patches, and resets a builtin without flipping enabled", () => {
    const disabled = updateAiActionCommand(shipped, "short", {
      enabled: false,
      title: "Brief",
      instruction: "One line.",
    });
    expect(disabled[0]).toMatchObject({ id: "short", enabled: false, title: "Brief" });
    const reset = resetBuiltinAiAction(disabled, "short");
    expect(reset[0]).toMatchObject({
      id: "short",
      enabled: false,
      title: "Short description",
      instruction: shipped[0]?.instruction,
    });
    expect(moveAiActionCommand(shipped, 0, 2).map((row) => row.id)).toEqual([
      "full",
      "impl",
      "short",
      "release",
      "review",
      "test",
    ]);
  });

  it("requires title and prompt only on enabled rows", () => {
    expect(aiActionsValid(shipped)).toBe(true);
    const blankEnabled = addAiActionCommand(shipped);
    expect(aiActionsValid(blankEnabled)).toBe(false);
    const disabledBlank = updateAiActionCommand(blankEnabled, blankEnabled[6]!.id, {
      enabled: false,
    });
    expect(aiActionsValid(disabledBlank)).toBe(true);
  });

  it("omits blank user rows from a persistable list and disables incomplete ones", () => {
    const withMine = addAiActionCommand(shipped);
    expect(persistableAiActions(withMine)).toEqual(shipped);
    const named = updateAiActionCommand(withMine, withMine[6]!.id, {
      title: "Jira comment",
    });
    const persisted = persistableAiActions(named);
    expect(persisted[persisted.length - 1]).toMatchObject({
      title: "Jira comment",
      enabled: false,
    });
  });
});
