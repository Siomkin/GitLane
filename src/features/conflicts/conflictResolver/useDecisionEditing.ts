// The decision-editing callbacks: picking a whole side, ticking individual
// lines, writing a custom hunk or a whole-file rewrite, and undoing either.
//
// All of them are pure state updaters over the resolver's single per-cell
// `HunkChoice` map — no fetches, no effects — so they live apart from the
// content lifecycle they are edited against. A cell holds exactly one choice,
// so superseding a prior kind is just replacing the entry; there is no "clear
// the other maps" step to get wrong. Each choice records the fingerprint of
// the hunk it was made against, which is what later invalidates it if that
// hunk changes on disk (GL-180).

import { useCallback } from "react";
import type { ConflictFileContent } from "@/lib/api";
import type { HunkChoice, WholeDecision } from "@/features/conflicts/conflictModel";
import { cell, dropFileCells, printAt, without } from "./keys";

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export interface DecisionEditingSetters {
  setSelected: Setter<string | null>;
  setChoices: Setter<Record<string, HunkChoice>>;
  setFileText: Setter<Record<string, { text: string; from: string }>>;
}

export function useDecisionEditing(
  setters: DecisionEditingSetters,
  /** Latest cached content, read at call time so a choice fingerprints the hunk
   * as it stands now rather than as it stood when the callback was created. */
  latestInputs: React.RefObject<{ cache: Record<string, ConflictFileContent> }>,
) {
  const { setSelected, setChoices, setFileText } = setters;
  const select = useCallback((path: string) => setSelected(path), [setSelected]);

  // A whole-file rewrite replaces every per-hunk choice for this path.
  const dropFileText = useCallback((path: string) => setFileText(without(path)), [setFileText]);

  // Fingerprint of the hunk a choice is being made against, from the content
  // cached at that moment. No print (no cached content / not a conflict hunk)
  // means no choice is recorded: one that can never be fingerprinted could
  // never be validated against disk either.
  const printNow = useCallback(
    (path: string, idx: number) => printAt(latestInputs.current.cache[path], idx),
    [latestInputs],
  );

  const decide = useCallback(
    (path: string, idx: number, decision: WholeDecision) => {
      const print = printNow(path, idx);
      if (print) {
        setChoices((m) => ({ ...m, [cell(path, idx)]: { kind: "whole", decision, print } }));
      }
      dropFileText(path);
    },
    [dropFileText, printNow, setChoices],
  );

  const setLineSelection = useCallback(
    (path: string, idx: number, selection: Set<string>) => {
      const key = cell(path, idx);
      // An emptied selection clears the hunk back to undecided.
      if (selection.size === 0) {
        setChoices(without(key));
      } else {
        const print = printNow(path, idx);
        if (print) setChoices((m) => ({ ...m, [key]: { kind: "lines", selection, print } }));
      }
      dropFileText(path);
    },
    [dropFileText, printNow, setChoices],
  );

  const setCustomResolution = useCallback(
    (path: string, idx: number, lines: string[]) => {
      const print = printNow(path, idx);
      if (print) {
        setChoices((m) => ({ ...m, [cell(path, idx)]: { kind: "custom", lines, print } }));
      }
      dropFileText(path);
    },
    [dropFileText, printNow, setChoices],
  );

  const setFileResolution = useCallback(
    (path: string, text: string, from: string) => {
      setChoices(dropFileCells(path));
      setFileText((f) => ({ ...f, [path]: { text, from } }));
    },
    [setChoices, setFileText],
  );

  const undo = useCallback(
    (path: string, idx: number) => {
      setChoices(without(cell(path, idx)));
      dropFileText(path);
    },
    [dropFileText, setChoices],
  );

  const resetFile = useCallback(
    (path: string) => {
      setChoices(dropFileCells(path));
      dropFileText(path);
    },
    [dropFileText, setChoices],
  );

  return {
    select,
    decide,
    setLineSelection,
    setCustomResolution,
    setFileResolution,
    undo,
    resetFile,
  };
}
