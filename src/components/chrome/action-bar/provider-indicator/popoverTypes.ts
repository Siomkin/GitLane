/** The shapes `model.ts` resolves a provider status into, and `ProviderPopover`
 * renders. Kept apart from the builders so the type surface stays readable. */

/** Glyph keys the popover resolves to real icon components in `ProviderPopover`.
 * Kept as strings so this module stays pure (no JSX) and unit-testable. */
export type PopoverIconKey =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "gitea"
  | "forgejo"
  | "azure"
  | "cloud"
  | "cloudOff"
  | "warning"
  | "pr"
  | "issue"
  | "gear"
  | "branch"
  | "people"
  | "webhook"
  | "key"
  | "external"
  | "plus"
  | "remotes";

/** What the popover's primary button does. Resolved to a handler in the view. */
export type PopoverAction =
  | { kind: "view-prs" }
  | { kind: "sign-in" }
  | { kind: "add-remote" }
  | { kind: "open-url"; url: string };

export interface PopoverLinkSpec {
  icon: PopoverIconKey;
  label: string;
  href: string;
}

export interface PopoverCapability {
  label: string;
  /** Colour classes for the pill (the component prepends shape/size). */
  tone: string;
}

export interface PopoverPrimary {
  icon: PopoverIconKey;
  label: string;
  /** Trailing affordance glyph ("→", "↗") or "" for none. */
  suffix: string;
  action: PopoverAction;
}

export interface ProviderSettingsSection {
  /** Eyebrow label, e.g. "Settings on github.com". */
  eyebrow: string;
  /** Monospace hint shown beside the eyebrow, e.g. "/settings". */
  mono: string;
  links: PopoverLinkSpec[];
}

/** Fully-resolved content for the provider popover, one shape for every status.
 * `headHref === null` renders a static (non-link) header; `primary === null`
 * drops the primary button (e.g. an unrecognised remote with no web URL). */
export interface ProviderPopoverModel {
  headerIcon: PopoverIconKey;
  headerTone: string;
  title: string;
  host: string;
  headHref: string | null;
  capability: PopoverCapability | null;
  note: string;
  primary: PopoverPrimary | null;
  /** Non-null shows the "On <host>" GitHub links group. */
  githubEyebrow: string | null;
  githubLinks: PopoverLinkSpec[];
  /** Non-null shows the "Settings on <host>" links group. */
  settings: ProviderSettingsSection | null;
}
