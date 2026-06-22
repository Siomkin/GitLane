/** Compact "Jun 22" date label shared by the commit and stash-context rows. */
export function formatDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
  });
}
