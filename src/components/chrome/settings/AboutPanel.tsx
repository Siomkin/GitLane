// About panel (Settings → About): app identity, the software-update card, an
// auto-check-daily toggle, build details, and license/links. Mirrors the About
// design in the Claude Design project. Update state lives in `useUpdates`; the
// auto-check pref in `useUi`; build details are read once from the Tauri app API.

import { useEffect, useState } from "react";
import { getTauriVersion, getIdentifier } from "@tauri-apps/api/app";

import { openExternalUrl } from "../../../lib/openExternal";
import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import { isLinux, isMac, isTauri, isWindows } from "../../../lib/platform";
import { useUi } from "../../../store/ui";
import { useUpdates } from "../../../store/updates";
import { GitLaneMarkIcon } from "../../ui/icons";
import { UpdateSection } from "./UpdateSection";

const REPO = "https://github.com/Siomkin/GitLane";
const LINKS: { label: string; url: string }[] = [
  { label: "Release notes", url: `${REPO}/releases` },
  { label: "License", url: `${REPO}/blob/latest/LICENSE` },
  { label: "Acknowledgements", url: `${REPO}#readme` },
];

const platformLabel = isMac ? "macOS" : isWindows ? "Windows" : isLinux ? "Linux" : "—";

/** The GitLane swimlane mark on a gradient tile (from the About design). */
function AppMark() {
  return (
    <span
      className="grid h-[68px] w-[68px] shrink-0 place-items-center rounded-[18px] text-white shadow-[0_12px_32px_-10px_rgba(0,0,0,0.45)]"
      style={{ background: "linear-gradient(135deg,#27c0a6,#4f7fd6,#e2a266)" }}
    >
      <GitLaneMarkIcon className="h-9 w-9" strokeWidth={2.1} />
    </span>
  );
}

export const AboutPanel = () => {
  const version = useUpdates((s) => s.version);
  const status = useUpdates((s) => s.status);
  const check = useUpdates((s) => s.check);
  const autoCheck = useUi((s) => s.autoCheckUpdates);
  const setAutoCheck = useUi((s) => s.setAutoCheckUpdates);
  const betaUpdates = useUi((s) => s.betaUpdates);
  const setBetaUpdates = useUi((s) => s.setBetaUpdates);
  const [meta, setMeta] = useState<{ tauri?: string; id?: string }>({});

  // Lock the channel toggle while a check/download/pending-restart is in flight.
  // `check()` no-ops in those states, so a mid-check flip would change the pref
  // without re-querying — the running check would settle on the *old* channel
  // (GL-154 review). Gating the toggle here (like the "Check for updates" button)
  // means the channel can't change under an in-flight check, so there's no stale
  // result to reconcile.
  const updateBusy = status === "checking" || status === "downloading" || status === "ready";

  useEffect(() => {
    if (!isTauri) return;
    void getTauriVersion().then((tauri) => setMeta((m) => ({ ...m, tauri }))).catch(() => {});
    void getIdentifier().then((id) => setMeta((m) => ({ ...m, id }))).catch(() => {});
  }, []);

  const rows: { label: string; value: string }[] = [
    { label: "Version", value: version || "—" },
    { label: "Tauri", value: meta.tauri ?? "—" },
    { label: "Platform", value: platformLabel },
    { label: "Identifier", value: meta.id ?? "space.gitlane.desktop" },
  ];

  return (
    <div className="max-w-[660px]">
      <div className="mb-1 text-[19px] font-bold text-neutral-800 dark:text-neutral-100">About</div>
      <div className="mb-[26px] text-[13px] text-neutral-500 dark:text-neutral-400">
        Version, build details, and software updates.
      </div>

      <div className="flex items-center gap-5">
        <AppMark />
        <div className="min-w-0">
          <div className="text-[24px] font-bold leading-none tracking-tight text-neutral-900 dark:text-white">GitLane</div>
          <div className="mt-2.5 font-mono text-[13.5px] text-neutral-500 dark:text-neutral-400">
            Version {version || "—"}
          </div>
          <div className="mt-1.5 text-[13px] text-neutral-500 dark:text-neutral-400">Visual git client for macOS</div>
        </div>
      </div>

      <div className="mt-7">
        <UpdateSection />
      </div>

      <div className="mt-3 flex items-center gap-4 rounded-xl border border-black/[0.07] p-4 dark:border-white/[0.08]">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">Automatically check for updates</div>
          <div className="mt-0.5 text-[12.5px] text-neutral-500 dark:text-neutral-400">
            Check once a day and light the titlebar when a new version is available.
          </div>
        </div>
        <button type="button"
          role="switch"
          aria-checked={autoCheck}
          aria-label="Automatically check for updates"
          onClick={() => setAutoCheck(!autoCheck)}
          className={cn(
            "flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors",
            autoCheck ? "justify-end bg-[var(--accent)]" : "justify-start bg-black/15 dark:bg-white/20",
            focusRing,
          )}
        >
          <span className="h-5 w-5 rounded-full bg-white shadow-sm" />
        </button>
      </div>

      <div className="mt-3 flex items-center gap-4 rounded-xl border border-black/[0.07] p-4 dark:border-white/[0.08]">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">Receive beta updates</div>
          <div className="mt-0.5 text-[12.5px] text-neutral-500 dark:text-neutral-400">
            Update to pre-release beta builds as soon as they ship. Recommended until a stable release is out.
          </div>
        </div>
        <button type="button"
          role="switch"
          aria-checked={betaUpdates}
          aria-label="Receive beta updates"
          disabled={updateBusy}
          onClick={() => {
            setBetaUpdates(!betaUpdates);
            // Re-check immediately so switching channel reflects right away (the
            // store reads the fresh pref one-shot; set() is synchronous). Quiet:
            // a found update still lights the indicator + this card, but flipping
            // to stable (which has no release yet) must not re-pop the "check
            // failed" error toast — the whole reason this toggle exists.
            void check({ quiet: true });
          }}
          className={cn(
            "flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors",
            betaUpdates ? "justify-end bg-[var(--accent)]" : "justify-start bg-black/15 dark:bg-white/20",
            updateBusy && "cursor-not-allowed opacity-50",
            focusRing,
          )}
        >
          <span className="h-5 w-5 rounded-full bg-white shadow-sm" />
        </button>
      </div>

      <div className="mt-7 text-[11px] font-bold tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
        BUILD DETAILS
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-black/[0.07] bg-white dark:border-white/[0.08] dark:bg-neutral-800/40">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex h-11 items-center justify-between gap-4 border-b border-black/[0.05] px-4 last:border-0 dark:border-white/[0.06]"
          >
            <span className="text-[13px] text-neutral-500 dark:text-neutral-400">{r.label}</span>
            <span className="font-mono text-[13px] text-neutral-800 dark:text-neutral-200">{r.value}</span>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-5 text-[12.5px] font-medium text-neutral-500 dark:text-neutral-400">
        {LINKS.map((l) => (
          <button type="button" key={l.label} onClick={() => openExternalUrl(l.url)} className={cn("transition-colors hover:text-[color:var(--accent)]", focusRing)}>
            {l.label}
          </button>
        ))}
      </div>

      <p className="mt-5 text-[11.5px] text-neutral-400 dark:text-neutral-600">
        © 2026 Alexander Siomkin. Released under the GPL-3.0 License.
      </p>
    </div>
  );
};
