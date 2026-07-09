import { useRepo } from "../store/repo";
import { useUi } from "../store/ui";
import { deriveCenterView, type CenterViewKey } from "./centerView";

/** The derived center-view key, subscribed narrowly (one boolean/primitive per
 * selector) so consumers re-render only when the *decision* changes, not on
 * every graph or diff churn. Both `App` (grid layout) and `CenterWorkspace`
 * (workspace dispatch) read this — the derivation itself stays in the pure
 * `deriveCenterView`. */
export const useCenterView = (): CenterViewKey => {
  const inConflict = useRepo((state) => !!state.operation);
  const comparing = useRepo((state) => !!state.compare);
  const fileHistoryOpen = useRepo((state) => !!state.fileHistory);
  const selectedFileSource = useRepo((state) => state.selectedFile?.source ?? null);
  const leftTab = useUi((state) => state.leftTab);
  const stackedReviewOpen = useUi((state) => !!state.stackedReview);
  const changesAll = useUi((state) => state.changesAll);
  return deriveCenterView({
    inConflict,
    leftTab,
    comparing,
    fileHistoryOpen,
    stackedReviewOpen,
    changesAll,
    selectedFileSource,
  });
};
