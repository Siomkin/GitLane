import type { CommitNode } from "@/lib/api";
import { identityColor, type IdentityColorOverrides } from "@/lib/identityColor";
import { parsePersonTrailers, uniqueTrailerPeople } from "@/lib/commitTrailers";
import claudeIconUrl from "@/assets/commit-agents/claude.svg";
import codexIconUrl from "@/assets/commit-agents/codex.svg";
import cursorIconUrl from "@/assets/commit-agents/cursor.svg";
import copilotIconUrl from "@/assets/commit-agents/copilot.svg";

interface CommitAgentPattern {
  name?: RegExp;
  email?: RegExp;
}

interface CommitAgentDefinition {
  id: string;
  label: string;
  iconUrl: string;
  /** Brand colour the (white) glyph sits on — the agent's identity colour,
   * the parallel to a human's `identityColor`. */
  color: string;
  patterns: readonly CommitAgentPattern[];
}

/** The single extension point for commit co-worker badges. Add one bundled
 * asset import and one registry entry; detection and image preloading consume
 * the registry without agent-specific branches. Keep patterns narrow enough
 * that a human working at the same company is not classified as an agent. */
export const KNOWN_COMMIT_AGENTS = [
  {
    id: "claude",
    label: "Claude",
    iconUrl: claudeIconUrl,
    color: "#d97757",
    patterns: [
      // Whole-name match, not a substring: a human "Claude Dupont" must not be
      // classified as the agent. Real agent commits author as exactly "Claude"
      // / "Claude Code" (or carry the anthropic.com email below).
      { name: /^claude(?:\s+code)?$/i },
      { email: /^(?:claude|noreply)@anthropic\.com$/i },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    iconUrl: codexIconUrl,
    color: "#0a0a0a",
    patterns: [
      { name: /^(?:openai\s+)?codex$/i },
      {
        email:
          /^(?:codex|openai-codex)@(?:openai\.com|users\.noreply\.github\.com)$/i,
      },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    iconUrl: cursorIconUrl,
    color: "#0a0a0a",
    patterns: [
      { name: /^cursor(?:\s+(?:agent|bot))?$/i },
      {
        email:
          /^(?:cursor|cursoragent|cursor-agent)@(?:cursor\.com|users\.noreply\.github\.com)$/i,
      },
    ],
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    iconUrl: copilotIconUrl,
    color: "#1f2328",
    patterns: [
      { name: /^(?:github\s+)?copilot(?:\[bot\])?$/i },
      {
        email:
          /^(?:\d+\+)?(?:github-)?copilot(?:\[bot\])?@(?:github\.com|users\.noreply\.github\.com)$/i,
      },
    ],
  },
] as const satisfies readonly CommitAgentDefinition[];

export type KnownCommitAgent = (typeof KNOWN_COMMIT_AGENTS)[number];

/** One co-author badge next to the node — a known agent (icon) or a person
 * (initials on their stable identity colour). */
export interface CommitCoAuthor {
  name: string;
  email: string;
  initials: string;
  color: string;
  agent: KnownCommitAgent | null;
}

export type CommitNodeIdentity =
  | { kind: "agent"; agent: KnownCommitAgent; coAuthors: CommitCoAuthor[] }
  | { kind: "human"; initials: string; color: string; coAuthors: CommitCoAuthor[] }
  | { kind: "fallback" };

const INITIAL_CHARACTER = /[\p{L}\p{N}]/u;
const UNKNOWN_AUTOMATION = /(?:\[bot\]\s*$|\b(?:bot|automation)\b)/i;

/** Resolve the visual identity for a graph node — the node IS the author:
 * a known agent author gets its icon, a human author their initials on the
 * per-identity colour. Co-authored-by trailers become the small companion
 * badge instead of replacing the author. The caller invokes this only for
 * visible rows. */
export function commitNodeIdentity(
  commit: Pick<CommitNode, "authorName" | "authorEmail" | "body">,
  overrides?: IdentityColorOverrides,
): CommitNodeIdentity {
  const coAuthors = commitCoAuthors(commit, overrides);
  const agent = knownAgent(commit.authorName, commit.authorEmail);
  if (agent) return { kind: "agent", agent, coAuthors };

  // Unknown automation is deliberately not presented as a person. Keep its
  // classic dot until it earns an explicit registry entry and bundled asset.
  if (UNKNOWN_AUTOMATION.test(commit.authorName)) return { kind: "fallback" };

  const initials = authorInitials(commit.authorName);
  if (!initials) return { kind: "fallback" };
  return {
    kind: "human",
    initials,
    color: identityColor(commit.authorEmail || commit.authorName, overrides),
    coAuthors,
  };
}

/** Co-authored-by trailers as badge identities, author excluded (a commit
 * whose author also signed a trailer shouldn't badge itself). */
function commitCoAuthors(
  commit: Pick<CommitNode, "authorEmail" | "body">,
  overrides?: IdentityColorOverrides,
): CommitCoAuthor[] {
  const trailers = parsePersonTrailers(commit.body).filter(
    (trailer) => trailer.key === "Co-authored-by",
  );
  return uniqueTrailerPeople(trailers, commit.authorEmail).map((person) => {
    const agent = knownAgent(person.name, person.email);
    return {
      name: person.name,
      email: person.email,
      initials: authorInitials(person.name) ?? "?",
      // An agent co-author badges in its brand colour (white glyph on top); a
      // human keeps their stable per-identity colour.
      color: agent ? agent.color : identityColor(person.email || person.name, overrides),
      agent,
    };
  });
}

export function authorInitials(name: string): string | null {
  const characters = name
    .trim()
    .split(/[\s._-]+/u)
    .map((part) => [...part].find((character) => INITIAL_CHARACTER.test(character)))
    .filter((character): character is string => character !== undefined);
  if (characters.length === 0) return null;
  const initials =
    characters.length === 1
      ? characters[0]
      : `${characters[0]}${characters[characters.length - 1]}`;
  return initials.toLocaleUpperCase();
}

/** Public resolver: the known agent for a name/email pair, or null for a
 * human. Lets other surfaces (trailer People rows) brand agents consistently. */
export function knownCommitAgent(name: string, email: string): KnownCommitAgent | null {
  return knownAgent(name, email);
}

function knownAgent(name: string, email: string): KnownCommitAgent | null {
  for (const agent of KNOWN_COMMIT_AGENTS) {
    if (agent.patterns.some((pattern) => matchesPattern(pattern, name, email))) {
      return agent;
    }
  }
  return null;
}

function matchesPattern(pattern: CommitAgentPattern, name: string, email: string): boolean {
  return (
    (pattern.name?.test(name.trim()) ?? false) ||
    (pattern.email?.test(email.trim()) ?? false)
  );
}
