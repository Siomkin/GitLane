// Request-slot ownership for the per-PR lazy resources (GL-166). Each load
// claims its PR's slot by writing a monotonic request id into its resource's
// `prResources.<kind>.slots` map (GL-364) — store state, so `reset()` clears it
// with the rest of the repo's PR state. On settle, a request may publish or
// clean up ONLY while it still owns the slot: a repo switch empties the map and
// a newer/forced load overwrites the id, so a stale response publishes nothing
// and never clears the current request's loading flag. The per-PR resource
// version stays a separate concern — it detects refresh prunes within one repo,
// not request identity.

/** In-flight request id per PR number for one lazy resource. Doubles as the
 * loading indicator: a key present means that PR's resource is loading. */
export type PrRequestSlots = Record<number, number>;

let nextPrRequestId = 1;

/** A fresh id to claim a PR's request slot with. One shared sequence across
 * resources — ids only ever compare for identity, never order. */
export function claimPrRequestId(): number {
  return nextPrRequestId++;
}

/** Whether `id` still owns `num`'s slot (no reset or newer claim since). */
export function ownsPrRequest(slots: PrRequestSlots, num: number, id: number): boolean {
  return slots[num] === id;
}
