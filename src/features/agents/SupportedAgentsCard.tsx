// "Add an agent": the ACP catalogue GitLane knows how to launch, folded under
// the user's configured list (AI Agents Redesign 1a). Ready adapters get an
// Add; missing ones offer a copyable install / docs link. Search + Ready /
// Needs install tabs filter the catalogue; the panel itself is the only scroll.

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { openExternalUrl } from "@/lib/openExternal";
import type { AcpAdapter } from "@/lib/api";
import { useAcpAgents } from "@/store/acpAgents";

type CatalogTab = "ready" | "install";

export function SupportedAgentsCard({
  addedCommands,
  onAdd,
  onAddCustom,
}: {
  /** ACP commands already backed by an agent, so a row can say so. */
  addedCommands: Set<string>;
  /** Turn this adapter into an agent the in-app menus can pick. */
  onAdd: (adapter: AcpAdapter) => void;
  /** Blank custom ACP adapter — any command that speaks the protocol. */
  onAddCustom: () => void;
}) {
  const adapters = useAcpAgents((s) => s.adapters);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<CatalogTab>("ready");

  const ready = adapters.filter((a) => a.available);
  const missing = adapters.filter((a) => !a.available);

  const q = query.trim().toLowerCase();
  const matches = (adapter: AcpAdapter) =>
    !q ||
    adapter.name.toLowerCase().includes(q) ||
    adapter.command.toLowerCase().includes(q) ||
    adapter.requires.toLowerCase().includes(q);

  const list = (tab === "ready" ? ready : missing).filter(matches);

  if (adapters.length === 0) {
    return (
      <section
        aria-label="Add an agent"
        className="overflow-hidden rounded-2xl border border-black/[0.08] bg-black/[0.02] dark:border-white/[0.08] dark:bg-black/20"
      >
        <CustomAdapterRow onAddCustom={onAddCustom} />
      </section>
    );
  }

  return (
    <section
      aria-label="Add an agent"
      className="overflow-hidden rounded-2xl border border-black/[0.08] bg-black/[0.02] dark:border-white/[0.08] dark:bg-black/20"
    >
      <div className="flex h-[56px] items-center gap-3 border-b border-black/[0.06] px-4 dark:border-white/[0.06]">
        <span className="text-[11px] font-semibold tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
          ADD AN AGENT
        </span>
        <div className="ml-auto flex h-9 w-[210px] items-center gap-2 rounded-lg border border-black/[0.1] bg-black/[0.03] px-3 dark:border-white/[0.1] dark:bg-white/[0.04]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents"
            spellCheck={false}
            aria-label="Search agents"
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
        </div>
      </div>

      <div className="px-4 pt-3">
        <div
          role="tablist"
          aria-label="Agent readiness"
          className="inline-grid grid-cols-2 gap-1 rounded-lg bg-black/[0.05] p-1 dark:bg-white/[0.06]"
        >
          <CatalogTabButton
            active={tab === "ready"}
            onClick={() => setTab("ready")}
            label={`Ready to use · ${ready.length}`}
          />
          <CatalogTabButton
            active={tab === "install"}
            onClick={() => setTab("install")}
            label={`Needs install · ${missing.length}`}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 p-4 pt-3">
        {list.length === 0 ? (
          <p className="col-span-2 py-6 text-center text-[12.5px] text-neutral-400 dark:text-neutral-500">
            {q
              ? "No agents match that search."
              : tab === "ready"
                ? "None of the agents GitLane knows about are installed yet."
                : "Every known agent already resolves on PATH."}
          </p>
        ) : (
          list.map((adapter) => (
            <CatalogCard
              key={adapter.id}
              adapter={adapter}
              added={addedCommands.has(adapter.command.trim())}
              onAdd={() => onAdd(adapter)}
            />
          ))
        )}
      </div>

      <CustomAdapterRow onAddCustom={onAddCustom} />
    </section>
  );
}

function CatalogTabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "h-8 rounded-md px-3.5 text-[12.5px] font-semibold transition-colors",
        active
          ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white"
          : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200",
        focusRing,
      )}
    >
      {label}
    </button>
  );
}

function CatalogCard({
  adapter,
  added,
  onAdd,
}: {
  adapter: AcpAdapter;
  added: boolean;
  onAdd: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyInstall = () => {
    if (!adapter.install) return;
    void navigator.clipboard?.writeText(adapter.install).then(() => setCopied(true));
  };

  const action = (() => {
    if (adapter.available) {
      return {
        label: added ? "Added" : "Add",
        disabled: added,
        onClick: onAdd,
        title: added
          ? `${adapter.name} is already in your list — open its menu to add another profile`
          : `Add ${adapter.name} to your agents so it appears in Draft and AI actions`,
      };
    }
    if (adapter.install) {
      return {
        label: copied ? "Copied" : "Copy install",
        disabled: false,
        onClick: copyInstall,
        title: `Copy: ${adapter.install}`,
      };
    }
    if (adapter.docs) {
      return {
        label: "Get the CLI",
        disabled: false,
        onClick: () => openExternalUrl(adapter.docs),
        title: adapter.docs,
      };
    }
    return {
      label: "Unavailable",
      disabled: true,
      onClick: () => {},
      title: "No install command or docs for this adapter yet",
    };
  })();

  return (
    <div className="flex items-start gap-3 rounded-xl border border-black/[0.07] bg-white/70 p-3 dark:border-white/[0.07] dark:bg-neutral-800/60">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              adapter.available ? "bg-emerald-400" : "bg-amber-400",
            )}
          />
          <span className="truncate text-[13.5px] font-semibold text-neutral-900 dark:text-white">
            {adapter.name}
          </span>
        </div>
        <div className="mt-1 text-[12px] leading-snug text-pretty text-neutral-500 dark:text-neutral-500">
          {adapter.requires}
        </div>
      </div>
      <button
        type="button"
        onClick={action.onClick}
        disabled={action.disabled}
        title={action.title}
        className={cn(
          "h-8 shrink-0 rounded-lg px-3 text-[12.5px] font-semibold transition",
          added && adapter.available
            ? "cursor-default bg-black/[0.04] text-neutral-500 dark:bg-white/[0.04] dark:text-neutral-500"
            : "bg-black/[0.08] text-neutral-800 hover:bg-black/[0.12] active:scale-[0.97] dark:bg-white/[0.08] dark:text-neutral-100 dark:hover:bg-white/[0.14]",
          focusRing,
        )}
      >
        {action.label}
      </button>
    </div>
  );
}

function CustomAdapterRow({ onAddCustom }: { onAddCustom: () => void }) {
  return (
    <button
      type="button"
      onClick={onAddCustom}
      className={cn(
        "flex h-[52px] w-full items-center gap-2 border-t border-black/[0.06] px-4 text-left text-[13px] font-medium text-neutral-500 transition hover:bg-black/[0.03] hover:text-neutral-900 dark:border-white/[0.06] dark:text-neutral-400 dark:hover:bg-white/[0.03] dark:hover:text-white",
        focusRing,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-4 w-4 shrink-0"
        aria-hidden
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
      Add a custom ACP adapter
      <span className="ml-2 hidden text-[12px] font-normal text-neutral-400 dark:text-neutral-600 sm:inline">
        Any command that speaks the protocol over stdio
      </span>
      <span className="ml-auto text-neutral-400 dark:text-neutral-600" aria-hidden>
        →
      </span>
    </button>
  );
}
