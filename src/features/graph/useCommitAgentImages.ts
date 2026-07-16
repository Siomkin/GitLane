import { useEffect, useReducer } from "react";
import {
  preloadCommitAgentImages,
  subscribeCommitAgentImages,
} from "./commitAgentImages";

/** Warm the fixed local icon set only while icon rendering is enabled. The
 * returned revision invalidates the canvas paint after each async decode. */
export function useCommitAgentImages(enabled: boolean): number {
  const [revision, bumpRevision] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribeCommitAgentImages(bumpRevision);
    preloadCommitAgentImages();
    return unsubscribe;
  }, [enabled]);

  return revision;
}
