// The ACP half of an expanded agent row: which adapter answers in-app, whether
// it currently works, and which model / effort / fast pins it runs with.
//
// The model and config-option lists come from the adapter's own `session/new`
// reply, so what the picker offers is exactly what the adapter accepts.
// When both `models.availableModels` and a model config option exist (Codex),
// the probe prefers the config-option list so effort stays a separate control
// instead of being duplicated as "Sol (low)/(medium)/…". Long model lists use
// a searchable combobox.

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { openExternalUrl } from "@/lib/openExternal";
import { Select } from "@/components/ui/Select";
import { SearchableSelect } from "@/components/ui/SearchableSelect";
import type { AcpAdapter, AcpConfigOption } from "@/lib/api";
import type { AcpStatus } from "@/store/acpAgents";
import { AcpStatusPill } from "./AcpStatusPill";
import {
  adapterChoiceOf,
  type AcpReadiness,
  bakedModelParamChips,
  commandForChoice,
  coveredBakedParamKeys,
  CUSTOM_ADAPTER,
  formatModelParams,
  modelLabel,
  NO_ADAPTER,
  SEARCHABLE_MODEL_THRESHOLD,
} from "./acpFields";

const field =
  "h-9 min-w-0 rounded-lg border border-transparent bg-black/[0.02] px-2.5 text-[13px] text-neutral-700 outline-none focus:border-[var(--accent)] focus:bg-white dark:bg-white/[0.04] dark:text-neutral-200 dark:focus:bg-neutral-800";

export function AcpAgentFields({
  command,
  model,
  config,
  adapters,
  status,
  readiness,
  onCommandChange,
  onModelChange,
  onConfigChange,
  onConnect,
}: {
  command: string;
  model: string;
  config: Record<string, string>;
  adapters: AcpAdapter[];
  status: AcpStatus;
  readiness?: AcpReadiness;
  onCommandChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onConfigChange: (id: string, value: string) => void;
  onConnect: () => void;
}) {
  const choice = adapterChoiceOf(command, adapters);
  const catalogue = adapters.find((adapter) => adapter.id === choice);
  const probe = status.state === "ok" ? status.probe : null;
  const models = probe?.models ?? [];
  const configOptions = probe?.configOptions ?? [];
  const connected = probe !== null;
  // Effective preset: the pin, else whatever the adapter is currently on.
  const effectiveModelId = model || probe?.currentModelId || "";
  const bakedChips = bakedModelParamChips(
    effectiveModelId,
    coveredBakedParamKeys(configOptions),
  );

  const modelOptions = [
    {
      value: "",
      label: `Adapter default${probe?.currentModelId ? ` (${probe.currentModelId})` : ""}`,
      hint: formatModelParams(probe?.currentModelId ?? "") || undefined,
    },
    ...models.map((entry) => ({
      value: entry.id,
      label: modelLabel(entry),
      hint: formatModelParams(entry.id) || entry.description || undefined,
    })),
  ];
  // A pin the adapter no longer advertises — a legacy id like
  // `gpt-5.6-sol[low]` after Codex moved to base ids plus a separate effort
  // option. It is still what gets sent, so it has to be selectable: without a
  // matching option the control reads "Adapter default" and the next click
  // silently drops the pin.
  if (model && !models.some((entry) => entry.id === model)) {
    modelOptions.splice(1, 0, {
      value: model,
      label: `${model} (not offered now)`,
      hint: formatModelParams(model) || undefined,
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-black/[0.06] bg-black/[0.015] p-2.5 dark:border-white/[0.07] dark:bg-white/[0.02]">
      <div className="flex items-center gap-2">
        <label className="w-[92px] shrink-0 text-[12px] font-medium text-neutral-500 dark:text-neutral-400">
          Adapter
        </label>
        <Select
          value={choice}
          onChange={(e) =>
            onCommandChange(commandForChoice(e.target.value, adapters, command))
          }
          aria-label="Adapter"
          wrapperClassName="flex-1"
          className={cn(field, "w-full")}
        >
          <option value={NO_ADAPTER}>Terminal only — no in-app actions</option>
          {adapters.map((adapter) => (
            <option key={adapter.id} value={adapter.id}>
              {adapter.name}
            </option>
          ))}
          <option value={CUSTOM_ADAPTER}>Custom adapter…</option>
        </Select>
        <AcpStatusPill status={status} readiness={readiness} />
      </div>

      {choice !== NO_ADAPTER && (
        <>
          <div className="flex items-center gap-2">
            <span className="w-[92px] shrink-0" />
            <input
              value={command}
              onChange={(e) => onCommandChange(e.target.value)}
              placeholder="npx -y @agentclientprotocol/…"
              aria-label="Adapter command"
              spellCheck={false}
              readOnly={choice !== CUSTOM_ADAPTER}
              className={cn(
                field,
                "flex-1 font-mono text-[12.5px]",
                choice !== CUSTOM_ADAPTER && "opacity-70",
              )}
            />
            {status.state !== "checking" && (
              <button
                type="button"
                onClick={onConnect}
                disabled={!command.trim()}
                title="Launch the adapter and read back its models"
                className={cn(
                  "inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-black/[0.1] bg-black/[0.03] px-3.5 text-[12.5px] font-medium text-neutral-700 transition hover:bg-black/[0.06] active:scale-[0.97] disabled:opacity-50 dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-neutral-200 dark:hover:bg-white/[0.1]",
                  focusRing,
                )}
              >
                {connected ? "Recheck" : "Connect"}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="w-[92px] shrink-0 text-[12px] font-medium text-neutral-500 dark:text-neutral-400">
              Model
            </label>
            {models.length > 0 ? (
              models.length >= SEARCHABLE_MODEL_THRESHOLD ? (
                <SearchableSelect
                  value={model}
                  onChange={onModelChange}
                  options={modelOptions}
                  ariaLabel="Model"
                  placeholder="Search models…"
                  wrapperClassName="flex-1"
                  className={cn(field, "w-full")}
                />
              ) : (
                <Select
                  value={model}
                  onChange={(e) => onModelChange(e.target.value)}
                  aria-label="Model"
                  wrapperClassName="flex-1"
                  className={cn(field, "w-full")}
                >
                  {modelOptions.map((option) => (
                    <option key={option.value || "default"} value={option.value} title={option.hint}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              )
            ) : (
              <p className="flex-1 text-[12px] text-neutral-400 dark:text-neutral-500">
                {connected
                  ? "This adapter does not offer model selection."
                  : model
                    ? `Pinned to ${model} — connect to change it.`
                    : "Connect to list the models this adapter offers."}
              </p>
            )}
          </div>

          {bakedChips.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-1.5 pl-[100px]"
              title="Locked into this model preset. Pick a different model (including effort/fast variants) to change these."
            >
              {bakedChips.map((chip) => (
                <span
                  key={chip.key}
                  className="inline-flex items-center gap-1 rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-neutral-500 dark:bg-white/[0.06] dark:text-neutral-400"
                >
                  <span className="font-medium text-neutral-600 dark:text-neutral-300">
                    {chip.label}
                  </span>
                  {chip.value}
                </span>
              ))}
            </div>
          )}

          {configOptions.map((option) => (
            <ConfigOptionField
              key={option.id}
              option={option}
              value={config[option.id] ?? ""}
              onChange={(value) => onConfigChange(option.id, value)}
            />
          ))}

          {status.state === "failed" && (
            <p role="alert" className="pl-[100px] text-[12px] leading-relaxed text-rose-600 dark:text-rose-400">
              {status.error}
            </p>
          )}
          {/* An install command the user can't reach is not an install command:
              this used to live only in the row's overflow menu, so the one
              moment it is needed — a launch that just failed — showed nothing
              to run. Shown until the adapter answers, then it is noise. */}
          {catalogue && !connected && (catalogue.install || catalogue.docs) && (
            <InstallHint install={catalogue.install} docs={catalogue.docs} name={catalogue.name} />
          )}
          {catalogue && status.state !== "failed" && (
            <p className="pl-[100px] text-[12px] text-neutral-400 dark:text-neutral-500">
              {catalogue.requires}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The adapter's install command, selectable and one click from the clipboard,
 *  beside a link to its docs. Adapters that need no install (their CLI is the
 *  adapter) get the docs link alone. */
function InstallHint({
  install,
  docs,
  name,
}: {
  install: string;
  docs: string;
  name: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex items-center gap-2">
      <label className="w-[92px] shrink-0 text-[12px] font-medium text-neutral-500 dark:text-neutral-400">
        {install ? "Install" : "Docs"}
      </label>
      {install ? (
        <>
          <code className="min-w-0 flex-1 select-all truncate rounded-lg bg-black/[0.04] px-2.5 py-2 font-mono text-[12px] text-neutral-700 dark:bg-white/[0.06] dark:text-neutral-200">
            {install}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(install).then(() => setCopied(true));
            }}
            title={`Copy: ${install}`}
            className={cn(
              "inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-black/[0.1] bg-black/[0.03] px-3.5 text-[12.5px] font-medium text-neutral-700 transition hover:bg-black/[0.06] active:scale-[0.97] dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-neutral-200 dark:hover:bg-white/[0.1]",
              focusRing,
            )}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-400 dark:text-neutral-500">
          {name} ships its own CLI — install it from the vendor.
        </span>
      )}
      {docs && (
        <button
          type="button"
          onClick={() => openExternalUrl(docs)}
          title={docs}
          className={cn(
            "inline-flex h-9 shrink-0 items-center justify-center rounded-lg px-2.5 text-[12.5px] font-medium text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/[0.07] dark:hover:text-neutral-200",
            focusRing,
          )}
        >
          Docs
        </button>
      )}
    </div>
  );
}

function ConfigOptionField({
  option,
  value,
  onChange,
}: {
  option: AcpConfigOption;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-[92px] shrink-0 text-[12px] font-medium text-neutral-500 dark:text-neutral-400">
        {option.name || option.id}
      </label>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={option.name || option.id}
        wrapperClassName="flex-1"
        className={cn(field, "w-full")}
      >
        <option value="">
          Adapter default
          {option.currentValue ? ` (${option.currentValue})` : ""}
        </option>
        {option.options.map((entry) => (
          <option key={entry.id} value={entry.id} title={entry.description}>
            {modelLabel(entry)}
          </option>
        ))}
      </Select>
    </div>
  );
}
