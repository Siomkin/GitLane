import type { SshConnection } from "@/lib/api";
import { cn } from "@/lib/cn";
import { REMOTE_LOCATOR_PREFIX } from "@/lib/paths";
import { focusRing } from "@/lib/ui";
import { connectionOrigin } from "@/store/remoteSessions";
import { PlusIcon, ServerIcon, SettingsIcon } from "@/components/ui/icons";

const rowClass = cn(
  "flex h-11 w-full items-center gap-2.5 px-3 text-left text-[13px] text-neutral-700 hover:bg-black/5 disabled:opacity-50 dark:text-neutral-200 dark:hover:bg-white/5",
  focusRing,
);

/** Step one: which machine. Saved connections first, then `~/.ssh/config`
 * hosts (usable without saving), then adding a connection. */
export function HostPicker({
  connections,
  sshHosts,
  busy,
  onPick,
  onAdd,
}: {
  connections: SshConnection[];
  sshHosts: string[];
  busy: boolean;
  /** Connect to this origin (a saved connection's key is applied by the backend). */
  onPick: (origin: string) => void;
  onAdd: () => void;
}) {
  const savedHosts = new Set(connections.filter((c) => !c.user && !c.port).map((c) => c.host));
  const configHosts = sshHosts.filter((h) => !savedHosts.has(h));
  return (
    <div className="mt-4 max-h-80 overflow-y-auto rounded-lg border border-black/10 dark:border-white/10">
      <ul aria-label="Hosts">
        {connections.map((c) => {
          const origin = connectionOrigin(c);
          return (
            <li key={origin}>
              <button type="button" disabled={busy} onClick={() => onPick(origin)} className={rowClass}>
                <ServerIcon className="h-4 w-4 shrink-0 text-[color:var(--accent)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate text-[11.5px] text-neutral-400">
                    {origin.slice(REMOTE_LOCATOR_PREFIX.length)}
                    {c.identityFile ? ` · ${c.identityFile}` : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {configHosts.map((h) => (
          <li key={h}>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPick(`${REMOTE_LOCATOR_PREFIX}${h}`)}
              title="From your SSH config"
              className={rowClass}
            >
              <SettingsIcon className="h-4 w-4 shrink-0 text-neutral-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{h}</span>
                <span className="block text-[11.5px] text-neutral-400">From ~/.ssh/config</span>
              </span>
            </button>
          </li>
        ))}
        <li className="border-t border-black/5 dark:border-white/5">
          <button type="button" disabled={busy} onClick={onAdd} className={cn(rowClass, "h-10")}>
            <PlusIcon className="h-4 w-4 shrink-0 text-neutral-400" />
            Add SSH connection…
          </button>
        </li>
      </ul>
    </div>
  );
}
