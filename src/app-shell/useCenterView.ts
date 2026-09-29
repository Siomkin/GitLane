import { centerViewInputOf, deriveCenterView, type CenterViewKey } from "@/store/centerView";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";

/** The derived center-view key, subscribed narrowly so consumers re-render
 * only when the *decision* changes, not on every graph or diff churn: the repo
 * selector returns the derived key itself. Both `App` (grid layout) and
 * `CenterWorkspace` (workspace dispatch) read this — the derivation itself
 * stays in the pure `deriveCenterView`. */
export const useCenterView = (): CenterViewKey => {
  const leftTab = useUi((state) => state.leftTab);
  const stackedReview = useUi((state) => state.stackedReview);
  const changesAll = useUi((state) => state.changesAll);
  return useRepo((state) =>
    deriveCenterView(centerViewInputOf(state, { leftTab, stackedReview, changesAll })),
  );
};
