// Global settings modal shell: owns the dialog chrome and sidebar navigation,
// and routes the active tab to one of the global panels under `settings/`
// (Appearance, Identities, Terminal Agents, About). It holds no
// settings-domain logic itself — each panel owns its presentation and store
// wiring. Per-repo config (Identity, Remotes) lives in the separate
// `RepoSettingsModal`, opened from the toolbar. Open/active-tab state comes
// from `useUi`.

import { useRef } from "react";
import { cn } from "../../lib/cn";
import { focusRing } from "../../lib/ui";
import { useDismiss } from "../../hooks/useDismiss";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useUi, type SettingsTab } from "../../store/ui";
import { useTerminalAgents } from "../../store/terminalAgents";
import { useUpdates } from "../../store/updates";
import { GitLaneMarkIcon } from "../ui/icons";
import { TerminalAgentsSettings } from "../../features/terminal/TerminalAgentsSettings";
import { GeneralPanel } from "./settings/GeneralPanel";
import { AccountsPanel } from "./settings/accounts-panel";
import { IdentitiesPanel } from "./settings/identities-panel";
import { AboutPanel } from "./settings/AboutPanel";

const TITLE_ID = "settings-modal-title";

// Accounts & identities lead the nav in their own group — they're the two
// halves of the identity model (accounts authenticate, identities author),
// distinct from app-level preferences.
const NAV: { key: SettingsTab; group: string; label: string }[] = [
  { key: "accounts", group: "ACCOUNTS & IDENTITIES", label: "Accounts" },
  { key: "identities", group: "ACCOUNTS & IDENTITIES", label: "Identities" },
  { key: "general", group: "APPLICATION", label: "Appearance" },
  { key: "terminal", group: "APPLICATION", label: "Terminal Agents" },
  { key: "about", group: "APPLICATION", label: "About" },
];

export function SettingsModal() {
  const open = useUi((s) => s.settingsOpen);
  const close = useUi((s) => s.closeSettings);
  const tab = useUi((s) => s.settingsTab);
  const setTab = useUi((s) => s.setSettingsTab);
  const enabledAgentCount = useTerminalAgents((s) => s.agents.filter((a) => a.enabled).length);
  const version = useUpdates((s) => s.version);
  // A confirm/prompt/sign-in dialog renders as an App-level
  // sibling at the same z-layer, outside our `dialogRef`. Suspend dismissal while
  // one is open so its Escape / backdrop click doesn't also tear down Settings
  // (which would drop the terminal editor's unsaved draft).
  const overlayBlocking = useUi(
    (s) =>
      s.confirm !== null ||
      s.prompt !== null ||
      s.githubSignin !== null ||
      // Provider OAuth is launched from the Accounts panel *inside* Settings, so
      // it must suspend Settings' dismiss AND focus trap too — otherwise the two
      // document-level traps fight and Escape/backdrop tears down Settings under
      // the OAuth dialog.
      s.providerOauthSignin !== null,
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  // Escape + outside-mousedown (backdrop) dismissal in one place. No-ops while closed.
  useDismiss(open && !overlayBlocking, close, dialogRef);
  // Trap Tab focus in the panel — but yield while a nested confirm/prompt/sign-in
  // overlay is up so that overlay's own trap owns focus.
  useFocusTrap(open && !overlayBlocking, dialogRef);
  if (!open) return null;

  const groups = NAV.reduce<Record<string, typeof NAV>>((acc, item) => {
    (acc[item.group] ??= []).push(item);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        tabIndex={-1}
        className="flex h-[min(84vh,880px)] min-h-[420px] w-[min(88vw,1240px)] min-w-[640px] max-w-[94vw] overflow-hidden rounded-2xl border border-black/10 bg-white shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] outline-none dark:border-white/10 dark:bg-neutral-800"
      >
        <nav className="flex w-[232px] flex-none flex-col border-r border-black/10 bg-black/[0.03] px-3 py-[18px] dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex items-center gap-[11px] px-2 pb-4">
            <span className="grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-[var(--accent-soft)] text-[color:var(--accent)]">
              ⚙
            </span>
            <span id={TITLE_ID} className="text-[17px] font-bold text-neutral-800 dark:text-neutral-100">Settings</span>
          </div>
          <div className="flex flex-1 flex-col gap-0.5 overflow-auto">
            {Object.entries(groups).map(([group, items]) => (
              <div key={group} className="flex flex-col gap-1">
                <div className="px-[11px] pb-1.5 pt-3 text-[10.5px] font-bold tracking-[0.06em] text-neutral-400">
                  {group}
                </div>
                {items.map((item) => (
                  <button type="button"
                    key={item.key}
                    onClick={() => setTab(item.key)}
                    aria-current={tab === item.key ? "page" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-[11px] py-2 text-left text-[13px]",
                      tab === item.key
                        ? "bg-black/[0.05] font-semibold text-neutral-800 dark:bg-white/[0.06] dark:text-neutral-100"
                        : "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5",
                      focusRing,
                    )}
                  >
                    <span className="flex-1">{item.label}</span>
                    {item.key === "terminal" && enabledAgentCount > 0 && (
                      <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-black/[0.06] px-1.5 text-[11px] font-semibold tabular-nums text-neutral-500 dark:bg-white/10 dark:text-neutral-400">
                        {enabledAgentCount}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <button type="button"
            onClick={() => setTab("about")}
            title="About GitLane"
            className={cn(
              "mt-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300",
              focusRing,
            )}
          >
            <GitLaneMarkIcon className="h-3.5 w-3.5" />
            <span>GitLane {version || "—"}</span>
          </button>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-none justify-end px-4 pt-3.5">
            <button type="button"
              onClick={close}
              aria-label="Close settings"
              className={cn(
                "rounded-lg px-2.5 py-1 text-[17px] text-neutral-500 hover:bg-black/5 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100",
                focusRing,
              )}
            >
              ✕
            </button>
          </div>
          <div
            className={cn(
              "min-h-0 flex-1 px-9 pt-1",
              tab === "terminal" ? "overflow-hidden pb-0" : "overflow-auto pb-9",
            )}
          >
            {tab === "general" && <GeneralPanel />}
            {tab === "accounts" && <AccountsPanel />}
            {tab === "identities" && <IdentitiesPanel />}
            {tab === "terminal" && <TerminalAgentsSettings />}
            {tab === "about" && <AboutPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
