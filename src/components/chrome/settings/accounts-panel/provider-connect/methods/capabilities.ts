// What a connection method covers, as the four tiles every method panel shows
// (fetch/pull, push, pull requests, stored by). Pure; each provider's
// `methods.ts` fills the values.

/** `yes`: works; `muted`: needs something else; `plain`: a fact, not a verdict. */
export type CapabilityTone = "yes" | "muted" | "plain";

export interface Capability {
  label: string;
  value: string;
  tone: CapabilityTone;
}

/** The four tiles in their fixed order; fetch and pull always work. */
export const capabilityRows = (push: string, prs: Capability, storedBy: string): Capability[] => [
  { label: "Fetch, pull", value: "Yes", tone: "yes" },
  { label: "Push", value: push, tone: "yes" },
  prs,
  { label: "Stored by", value: storedBy, tone: "plain" },
];
