import { useRepo } from "@/store/repo";
import { DiffTruncatedNotice } from "./DiffBody";

// "Show full diff" footer for a backend-truncated diff. Reads the store action
// directly so both diff modes can drop it in without prop-threading.
export function FullDiffNotice() {
  const loadFullFileDiff = useRepo((state) => state.loadFullFileDiff);
  const diffLoading = useRepo((state) => state.diffLoading);
  return <DiffTruncatedNotice onShowFull={loadFullFileDiff} loading={diffLoading} />;
}
