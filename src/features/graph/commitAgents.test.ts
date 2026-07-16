import { describe, expect, it } from "vitest";
import { authorInitials, commitNodeIdentity } from "./commitAgents";

function identity(
  authorName: string,
  authorEmail: string,
  body = "",
) {
  return commitNodeIdentity({ authorName, authorEmail, body });
}

describe("commitNodeIdentity", () => {
  it("keeps the human author on the dot and badges a known AI co-author", () => {
    expect(
      identity(
        "Alexander Siomkin",
        "alexander@example.com",
        "Implementation notes\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      ),
    ).toMatchObject({
      kind: "human",
      initials: "AS",
      coAuthors: [{ agent: { id: "claude" } }],
    });
  });

  it.each([
    ["Codex", "person@example.com", "codex"],
    ["Pair", "cursoragent@cursor.com", "cursor"],
    ["GitHub Copilot[bot]", "198982749+Copilot@users.noreply.github.com", "copilot"],
  ])("detects %s metadata as %s", (authorName, authorEmail, agentId) => {
    expect(identity(authorName, authorEmail)).toMatchObject({
      kind: "agent",
      agent: { id: agentId },
    });
  });

  it("does not classify a human OpenAI email as Codex", () => {
    expect(identity("Ada Lovelace", "ada@openai.com")).toMatchObject({
      kind: "human",
      initials: "AL",
    });
  });

  it.each([
    ["Claude Dupont", "claude.dupont@example.com"],
    ["Cursor Malovic", "cursor.malovic@example.com"],
    ["Codex Rivera", "codex.rivera@example.com"],
  ])("treats a human whose name merely contains an agent word as human: %s", (name, email) => {
    expect(identity(name, email).kind).toBe("human");
  });

  it("gives a human author a stable identity colour", () => {
    const first = identity("José Ángel", "jose@example.com");
    const second = identity("José Ángel", "JOSE@example.com ");
    expect(first).toMatchObject({ kind: "human", initials: "JÁ" });
    if (first.kind !== "human" || second.kind !== "human") throw new Error("expected humans");
    expect(second.color).toBe(first.color);
  });

  it("collects human co-authors with initials and colour, excluding the author", () => {
    const result = identity(
      "Marta Kowalska",
      "marta@example.com",
      [
        "Body",
        "",
        "Co-authored-by: Jonas Deri <jonas@example.com>",
        "Co-authored-by: Marta Kowalska <marta@example.com>",
        "Co-authored-by: Jonas Deri <jonas@example.com>",
      ].join("\n"),
    );
    expect(result).toMatchObject({
      kind: "human",
      coAuthors: [{ name: "Jonas Deri", initials: "JD", agent: null }],
    });
  });

  it("brands an agent co-author in its own colour, not a hashed identity colour", () => {
    const result = identity(
      "Marta Kowalska",
      "marta@example.com",
      "Work\n\nCo-authored-by: Claude <noreply@anthropic.com>",
    );
    if (result.kind !== "human") throw new Error("expected human author");
    const [claude] = result.coAuthors;
    expect(claude.agent?.id).toBe("claude");
    expect(claude.color).toBe(claude.agent?.color);
  });

  it("ignores non-co-author trailers for the node badge", () => {
    const result = identity(
      "Marta Kowalska",
      "marta@example.com",
      "Fix\n\nReviewed-by: Jonas Deri <jonas@example.com>",
    );
    expect(result).toMatchObject({ kind: "human", coAuthors: [] });
  });

  it("falls back for missing authors and unknown automation", () => {
    expect(identity("", "unknown@example.com")).toEqual({ kind: "fallback" });
    expect(identity("github-actions[bot]", "bot@users.noreply.github.com")).toEqual({
      kind: "fallback",
    });
  });
});

describe("authorInitials", () => {
  it("uses the first and last word and handles a single name", () => {
    expect(authorInitials("Alexander Michael Siomkin")).toBe("AS");
    expect(authorInitials("codergirl")).toBe("C");
    expect(authorInitials("  ")).toBeNull();
  });
});
