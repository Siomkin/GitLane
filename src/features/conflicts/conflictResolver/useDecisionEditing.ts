// The decision-editing callbacks: picking a whole side, ticking individual
// lines, writing a custom hunk or a whole-file rewrite, and undoing either.
//
// All of them are pure state updaters over the resolver's maps — no fetches, no
// effects — so they live apart from the content lifecycle they are edited
// against. Each choice also records the fingerprint of the hunk it was made
// against, which is what later invalidates it if that hunk changes on disk
// (GL-180).

import { useCallback } from "react";
import type { ConflictFileContent } from "@/lib/api";
import type { RegionDecision } from "@/features/conflicts/conflictModel";
import { cell, cellMatcher, printAt, without } from "./keys";

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export interface DecisionEditingSetters {
  setSelected: Setter<string | null>;
  setDecisions: Setter<Record<string, RegionDecision>>;
  setLineSel: Setter<Record<string, Set<string>>>;
  setHunkPrints: Setter<Record<string, string>>;
  setCustomText: Setter<Record<string, string[]>>;
  setFileText: Setter<Record<string, { text: string; from: string }>>;
}

export function useDecisionEditing(
  setters: DecisionEditingSetters,
  /** Latest cached content, read at call time so a choice fingerprints the hunk
   * as it stands now rather than as it stood when the callback was created. */
  latestInputs: React.RefObject<{ cache: Record<string, ConflictFileContent> }>,
) {
  const {
    setSelected,
    setDecisions,
    setLineSel,
    setHunkPrints,
    setCustomText,
    setFileText,
  } = setters;
  const select = useCallback((path: string) => setSelected(path), [setSelected]);

  // Record (or clear) the fingerprint of the hunk a cell's choice was made
  // against, from the content cached at that moment — the print is what later
  // invalidates the choice if the hunk changes on disk (GL-180).
  const dropFileText = useCallback((path: string) => setFileText(without(path)), [setFileText]);

  const setPrint = useCallback((key: string, print: string | undefined) => {
    setHunkPrints((p) => {
      if (print) return p[key] === print ? p : { ...p, [key]: print };
      return without<string>(key)(p);
    });
  }, [setHunkPrints]);

  const decide = useCallback(
    (path: string, idx: number, decision: RegionDecision) => {
      const key = cell(path, idx);
      setDecisions((d) => ({ ...d, [key]: decision }));
      setPrint(key, printAt(latestInputs.current.cache[path], idx));
      // A whole-hunk choice supersedes any prior line-level picks or rewrite.
      setLineSel(without(key));
      setCustomText(without(key));
      dropFileText(path);
    },
    [dropFileText, latestInputs, setCustomText, setDecisions, setLineSel, setPrint],
  );

  const setLineSelection = useCallback(
    (path: string, idx: number, selection: Set<string>) => {
      const key = cell(path, idx);
      setLineSel((s) => {
        const next = { ...s };
        if (selection.size === 0) delete next[key];
        else next[key] = selection;
        return next;
      });
      // An emptied selection clears the hunk back to undecided — no print left.
      setPrint(
        key,
        selection.size > 0 ? printAt(latestInputs.current.cache[path], idx) : undefined,
      );
      // Ticking lines replaces a custom resolution outright.
      setCustomText(without(key));
      // A line selection is its own decision mode; drop any whole-hunk choice so
      // the effective decision derives from the picks (or clears when empty).
      setDecisions(without(key));
      dropFileText(path);
    },
    [dropFileText, latestInputs, setCustomText, setDecisions, setLineSel, setPrint],
  );

  // A custom resolution is its own decision mode: the literal lines live in
  // `customText`, the hunk's decision becomes "custom", and any prior picks go
  // (they would otherwise win in `effectiveDecision`).
  const setCustomResolution = useCallback(
    (path: string, idx: number, lines: string[]) => {
      const key = cell(path, idx);
      setCustomText((c) => ({ ...c, [key]: lines }));
      setDecisions((d) => ({ ...d, [key]: "custom" }));
      setPrint(key, printAt(latestInputs.current.cache[path], idx));
      setLineSel(without(key));
      dropFileText(path);
    },
    [dropFileText, latestInputs, setCustomText, setDecisions, setLineSel, setPrint],
  );

  const setFileResolution = useCallback((path: string, text: string, from: string) => {
    // A whole-file rewrite replaces every per-hunk choice for this path.
    const isCell = cellMatcher(path);
    const drop = <T,>(m: Record<string, T>): Record<string, T> => {
      const next = { ...m };
      let changed = false;
      for (const k of Object.keys(next)) {
        if (isCell(k)) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : m;
    };
    setDecisions(drop);
    setLineSel(drop);
    setCustomText(drop);
    setHunkPrints(drop);
    setFileText((f) => ({ ...f, [path]: { text, from } }));
  }, [setCustomText, setDecisions, setFileText, setHunkPrints, setLineSel]);

  const undo = useCallback((path: string, idx: number) => {
    // Each setter infers its own value type, so the key is bound four times
    // rather than sharing one erased updater.
    const key = cell(path, idx);
    setDecisions(without(key));
    setLineSel(without(key));
    setCustomText(without(key));
    setHunkPrints(without(key));
    dropFileText(path);
  }, [dropFileText, setCustomText, setDecisions, setHunkPrints, setLineSel]);

  const resetFile = useCallback((path: string) => {
    const isCell = cellMatcher(path);
    const drop = <T,>(m: Record<string, T>): Record<string, T> => {
      const next = { ...m };
      let changed = false;
      for (const k of Object.keys(next)) {
        if (isCell(k)) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : m;
    };
    setDecisions(drop);
    setLineSel(drop);
    setCustomText(drop);
    setHunkPrints(drop);
    dropFileText(path);
  }, [dropFileText, setCustomText, setDecisions, setHunkPrints, setLineSel]);

  return {
    select,
    dropFileText,
    setPrint,
    decide,
    setLineSelection,
    setCustomResolution,
    setFileResolution,
    undo,
    resetFile,
  };
}
