// Settings → SSH Connections (remote-ssh-repos D11): the saved connections the
// open-remote dialog offers, with add, edit and remove. The form is the same
// one the dialog uses.

import { useEffect, useState } from "react";
import type { SshConnection } from "@/lib/api";
import { cn } from "@/lib/cn";
import { REMOTE_LOCATOR_PREFIX } from "@/lib/paths";
import { focusRing } from "@/lib/ui";
import { connectionOrigin, useRemoteSessions } from "@/store/remoteSessions";
import { PlusIcon, ServerIcon } from "@/components/ui/icons";
import { ConnectionForm } from "@/components/chrome/overlays/dialogs/open-remote/ConnectionForm";
import { SectionLabel } from "./controls";

const smallButton = cn(
  "h-7 rounded-md px-2.5 text-[12px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5",
  focusRing,
);

export function SshConnectionsPanel() {
  const connections = useRemoteSessions((s) => s.connections);
  const loadConnections = useRemoteSessions((s) => s.loadConnections);
  const deleteConnection = useRemoteSessions((s) => s.deleteConnection);
  // null: the list; "new": adding; a connection: editing it.
  const [editing, setEditing] = useState<SshConnection | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  if (editing) {
    return (
      <div className="max-w-[520px]">
        <SectionLabel>{editing === "new" ? "ADD SSH CONNECTION" : "EDIT SSH CONNECTION"}</SectionLabel>
        <ConnectionForm
          editing={editing === "new" ? null : editing}
          onSaved={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div className="max-w-[560px]">
      <SectionLabel>SSH CONNECTIONS</SectionLabel>
      <p className="mb-4 text-[12.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Servers you open repositories on over SSH. A connection's key file is used every time GitLane
        connects to that server, and its name appears on the server's tabs.
      </p>
      {connections.length > 0 ? (
        <ul aria-label="SSH connections" className="rounded-lg border border-black/10 dark:border-white/10">
          {connections.map((c) => {
            const origin = connectionOrigin(c);
            return (
              <li
                key={origin}
                className="flex items-center gap-3 border-b border-black/5 px-3 py-2.5 last:border-b-0 dark:border-white/5"
              >
                <ServerIcon className="h-4 w-4 shrink-0 text-[color:var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-100">{c.name}</div>
                  <div className="truncate text-[11.5px] text-neutral-400">
                    {origin.slice(REMOTE_LOCATOR_PREFIX.length)}
                    {c.identityFile ? ` · ${c.identityFile}` : ""}
                  </div>
                </div>
                <button type="button" className={smallButton} onClick={() => setEditing(c)}>
                  Edit
                </button>
                <button
                  type="button"
                  className={smallButton}
                  aria-label={`Remove ${c.name}`}
                  onClick={() => {
                    setError(null);
                    deleteConnection(origin).catch((e: unknown) =>
                      setError(e instanceof Error ? e.message : String(e)),
                    );
                  }}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-black/10 px-4 py-5 text-[12.5px] text-neutral-400 dark:border-white/10">
          No saved connections yet.
        </div>
      )}
      {error && <div className="mt-2 text-[12px] text-rose-500">{error}</div>}
      <button
        type="button"
        onClick={() => setEditing("new")}
        className={cn(
          "mt-3 flex h-8 items-center gap-1.5 rounded-lg border border-black/10 px-3 text-[12.5px] hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5",
          focusRing,
        )}
      >
        <PlusIcon className="h-3.5 w-3.5" />
        Add SSH connection
      </button>
    </div>
  );
}
