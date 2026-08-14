// Pure helpers for the ACP half of an agent row — no React, no IPC.
//
// An AI agent is an adapter command plus an optional pinned model. Which
// adapter it maps to decides what the Settings picker shows; the model list
// comes from the adapter itself, never from a hard-coded table.

import type { AcpAdapter, AcpModel } from "@/lib/api";

/** Sentinel for "not one of the catalogue adapters" in the adapter picker.
 *  A named const because it is compared, not just rendered. */
export const CUSTOM_ADAPTER = "custom";
/** Sentinel for "terminal only" — no ACP command at all. */
export const NO_ADAPTER = "";

/** Which picker option a command corresponds to: a catalogue adapter id, the
 *  custom sentinel, or none. Matching is exact — a tweaked command is the
 *  user's, and silently re-labelling it as a known adapter would hide that. */
export function adapterChoiceOf(acpCommand: string, adapters: AcpAdapter[]): string {
  const command = acpCommand.trim();
  if (!command) return NO_ADAPTER;
  return adapters.find((adapter) => adapter.command === command)?.id ?? CUSTOM_ADAPTER;
}

/** The command a picker choice selects. `custom` keeps whatever is already
 *  there so switching to it doesn't wipe the field the user is about to edit. */
export function commandForChoice(
  choice: string,
  adapters: AcpAdapter[],
  current: string,
): string {
  if (choice === NO_ADAPTER) return "";
  if (choice === CUSTOM_ADAPTER) return current;
  return adapters.find((adapter) => adapter.id === choice)?.command ?? current;
}

/** How much a PATH lookup proves about an adapter, before anything is launched.
 *
 * `ready` — the adapter's own binary is installed.
 * `unproven` — only its package runner is (see [`isPackageRunnerCommand`]).
 * `missing` — the command's program is nowhere on PATH. */
export type AcpReadiness = "ready" | "unproven" | "missing";

/** Package runners that fetch the adapter at launch: `npx -y @scope/pkg` and
 *  friends. Every machine with Node has `npx`, so finding one says nothing
 *  about the adapter behind it — a row that reported "Ready" on that evidence
 *  was green for adapters that had never been installed or run. Mirrors the
 *  runner table in `src-tauri/src/acp/process.rs`, which uses it to blame the
 *  toolchain rather than the adapter when a launch fails. */
const PACKAGE_RUNNERS = new Set([
  "npx",
  "npm",
  "pnpx",
  "pnpm",
  "yarn",
  "bunx",
  "bun",
  "uvx",
  "uv",
  "deno",
]);

/** True when the command starts with one of those runners. Matching is on the
 *  file name, so an absolute `C:\…\npx.cmd` answers like a bare `npx`. */
export function isPackageRunnerCommand(command: string): boolean {
  const file = programOf(command).split(/[\\/]/).pop() ?? "";
  return PACKAGE_RUNNERS.has(file.replace(/\.(cmd|bat|exe|ps1)$/i, "").toLowerCase());
}

/** The executable a command line names. A quoted first token stays whole, since
 *  that is how a path with spaces is written (`"C:\Program Files\…\npx.cmd"`);
 *  the Rust side tokenizes the same command with `shell_words`. */
function programOf(command: string): string {
  const text = command.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    return end > 0 ? text.slice(1, end) : text.slice(1);
  }
  return text.split(/\s+/)[0] ?? "";
}

/** What `available` (a PATH lookup in Rust) is worth for this command. */
export function readinessOf(command: string, available: boolean): AcpReadiness {
  if (!available) return "missing";
  return isPackageRunnerCommand(command) ? "unproven" : "ready";
}

/** Label for a model option. Adapters name effort variants inside the id
 *  (`gpt-5.6-sol[low]`), so fall back to the id rather than showing nothing. */
export function modelLabel(model: AcpModel): string {
  return model.name.trim() || model.id;
}

/** Params baked into an ACP model id.
 *
 * Cursor embeds them as `name[effort=high,fast=true]`; older Codex-style
 * lists used a bare suffix `name[low]`. Adapters that expose a separate
 * thought_level control don't need this — it's for presets where effort is
 * locked into the only offered variant. */
export function parseModelParams(modelId: string): Record<string, string> {
  const open = modelId.indexOf("[");
  const close = modelId.lastIndexOf("]");
  if (open < 0 || close <= open) return {};
  const body = modelId.slice(open + 1, close).trim();
  if (!body) return {};
  // Bare effort suffix: `gpt-5.6-sol[low]`.
  if (!body.includes("=")) return { effort: body };
  const out: Record<string, string> = {};
  for (const part of body.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

const BAKED_PARAM_CHIPS = [
  { key: "effort", label: "Effort" },
  { key: "reasoning", label: "Reasoning" },
  { key: "fast", label: "Fast" },
  { key: "thinking", label: "Thinking" },
] as const;

/** Param keys already covered by an editable session config option — don't
 *  also show them as read-only chips (Codex Effort / Fast). */
export function coveredBakedParamKeys(
  configOptions: { id: string; category: string }[],
): Set<string> {
  const keys = new Set<string>();
  for (const option of configOptions) {
    if (
      option.category === "thought_level" ||
      option.id === "effort" ||
      option.id === "reasoning_effort"
    ) {
      keys.add("effort");
      keys.add("reasoning");
    }
    if (option.category === "model_config" || option.id.includes("fast")) {
      keys.add("fast");
    }
  }
  return keys;
}

/** The pinned effort in a saved config, whatever the adapter calls it —
 *  claude-agent-acp says `effort`, Codex says `reasoning_effort`. Reading only
 *  the first left Codex's pin invisible on the collapsed row. */
export function effortPinOf(config: Record<string, string>): string {
  const key = Object.keys(config).find((id) => id.includes("effort"));
  return key ? config[key]! : "";
}

/** Read-only chips for params locked into the selected model preset. */
export function bakedModelParamChips(
  modelId: string,
  covered: Iterable<string> = [],
): { key: string; label: string; value: string }[] {
  if (!modelId) return [];
  const skip = new Set(covered);
  const params = parseModelParams(modelId);
  return BAKED_PARAM_CHIPS.filter(({ key }) => params[key] && !skip.has(key)).map(
    ({ key, label }) => ({ key, label, value: params[key]! }),
  );
}

/** Compact `effort=high · fast=true` annotation for option hints / chips. */
export function formatModelParams(modelId: string): string {
  return bakedModelParamChips(modelId)
    .map(({ key, value }) => `${key}=${value}`)
    .join(" · ");
}

/** Native `<select>` stays usable below this; above it, Settings uses a
 *  searchable combobox (Cursor's `--list-models` returns ~200 entries). */
export const SEARCHABLE_MODEL_THRESHOLD = 10;

/** A name not already in `taken`, suffixed with a counter if needed.
 *
 * Adding a second agent for one adapter is the normal way to keep two models
 * side by side ("codex" and "codex 5.6 sol light"), and the menu lists agents by
 * name — so two rows called "Cursor" would be indistinguishable exactly where it
 * matters. */
export function uniqueAgentName(base: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (name) => name.trim().toLowerCase()));
  if (!used.has(base.trim().toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
