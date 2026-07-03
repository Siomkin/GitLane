// Classify the success output of the `merge_branch` command. Even under
// `--no-ff`, merging a branch whose tip is already reachable from HEAD (equal
// tips included) creates nothing — git exits 0 with "Already up to date." — so
// the caller's toast must not claim a merge happened. The backend pins the
// merge subprocess to `LC_ALL=C` (src-tauri/src/git/write/branches.rs), which
// makes this English phrase safe to match regardless of the user's locale; the
// hyphenated spelling covers git < 2.17.
const ALREADY_UP_TO_DATE = /^already up[ -]to[ -]date[.!]?$/i;

/** True when a successful `git merge` was a no-op because the branch's tip is
 *  already reachable from HEAD — nothing was created. */
export function mergeWasAlreadyUpToDate(output: string): boolean {
  return output.split("\n").some((line) => ALREADY_UP_TO_DATE.test(line.trim()));
}
