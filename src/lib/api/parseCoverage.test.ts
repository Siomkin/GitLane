// Structural guard for the "every command response is validated at the API
// seam" requirement (ipc/commands spec): walks every wrapper module under
// `src/lib/api` and asserts that each `invoke(` call site either hands its
// result straight to `parse(` — the `parse(schema, await invoke("cmd", …), "cmd")`
// form — or names a command whose wrapper resolves to `void`, listed below.
//
// A new wrapper that forgets `parse` fails here with the file and command; a
// void command that later grows a payload fails when it is parsed while still
// on the allow-list, so the list can't rot.
//
// Sources come from `import.meta.glob` (as `no-raw-select.test.ts` does) rather
// than a `node:fs` walk so the check needs no `@types/node`.

import { describe, expect, it } from "vitest";

/** Every wrapper module under `src/lib/api`, keyed by path relative to this
 * folder. Excludes the tests and the modules that are the seam itself
 * (`invoke.ts`, `validate.ts`, `events.ts`), not wrappers over it. */
const WRAPPERS = import.meta.glob<string>(
  ["./**/*.ts", "!./**/*.test.ts", "!./invoke.ts", "!./validate.ts", "!./events.ts"],
  { query: "?raw", import: "default", eager: true },
);

/** Commands whose wrapper resolves to `void`: the backend returns `()` (or the
 * wrapper discards a status string), so there is nothing to validate. */
const VOID_COMMANDS = [
  "acp_agents_set",
  "cancel_clone",
  "cancel_github_sign_in",
  "cancel_provider_oauth_sign_in",
  "commit_agent_messages_set",
  "delete_provider_token",
  "github_sign_out",
  "pty_kill",
  "pty_resize",
  "pty_write",
  "refresh_tool_probes",
  "remove_index_lock",
  "reveal_path",
  "set_oauth_client_id",
  "terminal_agents_set",
  "unwatch_repo",
  "watch_repo",
];

interface CallSite {
  file: string;
  command: string;
  parsed: boolean;
}

const INVOKE_CALL = /\binvoke(?:<[^>]*>)?\(\s*"([a-z_]+)"/g;

/** True when the text just before `invoke` reads `parse(<schema>, await ` —
 * i.e. the call is the second argument of `parse`. Walks back over `await`,
 * the comma, then a balanced first argument, and expects `parse(` before it. */
function isParseArgument(source: string, invokeAt: number): boolean {
  let i = invokeAt - 1;
  const skipSpace = () => {
    while (i >= 0 && /\s/.test(source[i])) i--;
  };
  skipSpace();
  if (source.slice(i - 4, i + 1) !== "await") return false;
  i -= 5;
  skipSpace();
  if (source[i] !== ",") return false;
  i--;
  // Balanced first argument: stop at a `(` at depth 0 — the `parse(` paren.
  let depth = 0;
  for (; i >= 0; i--) {
    const ch = source[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) break;
      depth--;
    }
  }
  if (i < 0) return false;
  return source.slice(Math.max(0, i - 5), i) === "parse";
}

function callSites(): CallSite[] {
  return Object.entries(WRAPPERS).flatMap(([file, source]) => {
    const sites: CallSite[] = [];
    for (const match of source.matchAll(INVOKE_CALL)) {
      sites.push({
        file: `src/lib/api/${file.slice(2)}`,
        command: match[1],
        parsed: isParseArgument(source, match.index),
      });
    }
    return sites;
  });
}

describe("lib/api: every invoke() result passes through parse()", () => {
  const sites = callSites();

  it("finds the wrapper call sites", () => {
    // A sanity floor so an empty walk (moved folder, changed extension) can't
    // pass vacuously.
    expect(sites.length).toBeGreaterThan(100);
  });

  it("parses every command that resolves with a payload", () => {
    const unparsed = sites
      .filter((site) => !site.parsed && !VOID_COMMANDS.includes(site.command))
      .map((site) => `${site.file}: ${site.command}`);
    expect(unparsed).toEqual([]);
  });

  it("keeps the void allow-list exact", () => {
    const parsedButListed = sites
      .filter((site) => site.parsed && VOID_COMMANDS.includes(site.command))
      .map((site) => `${site.file}: ${site.command}`);
    expect(parsedButListed).toEqual([]);

    const invoked = new Set(sites.map((site) => site.command));
    const stale = VOID_COMMANDS.filter((command) => !invoked.has(command));
    expect(stale).toEqual([]);
  });

  it("recognises the canonical parse form and rejects the bare call", () => {
    const parsed = 'x: async () => parse(z.array(z.string()), await invoke("cmd"), "cmd")';
    expect(isParseArgument(parsed, parsed.indexOf("invoke"))).toBe(true);

    const nullable = 'x: async () => parse(fooSchema.nullable(), await invoke("cmd", { a }), "cmd")';
    expect(isParseArgument(nullable, nullable.indexOf("invoke"))).toBe(true);

    const bare = 'x: () => invoke<string>("cmd", { a })';
    expect(isParseArgument(bare, bare.indexOf("invoke"))).toBe(false);

    const awaitedOnly = 'x: async () => { await invoke("cmd"); }';
    expect(isParseArgument(awaitedOnly, awaitedOnly.indexOf("invoke"))).toBe(false);
  });
});
