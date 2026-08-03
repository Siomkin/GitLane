// The one-shot delivery contract appended to every terminal-agent prompt that
// expects a text artifact back (commit drafts, change descriptions).
//
// Every clause is load-bearing: the agent must not dirty the working tree (a
// tracked-file write republishes the changes and cancels the poll waiting for
// the result), must deliver through the Git-metadata mailbox via tmp + atomic
// rename (so GitLane never reads a half-written file), and must not re-read the
// mailbox afterward (GitLane deletes it on read, so a check looks like failure).
export function mailboxDeliveryContract(filename: string): string {
  return (
    "Do not commit. Do not create, edit, stage, or delete any working-tree file. " +
    `To deliver, run \`git rev-parse --git-path '${filename}'\` — it prints <mailbox>. ` +
    "Using shell commands, not apply_patch, write only the final plain text to `<mailbox>.tmp`, " +
    "then rename it to `<mailbox>` as your last action; those two Git-metadata paths are the only authorized filesystem writes. " +
    "GitLane deletes the mailbox the moment it reads it, so a successful rename means delivery succeeded — do not inspect, read, list, or verify it afterward. " +
    "Then end the turn immediately."
  );
}
