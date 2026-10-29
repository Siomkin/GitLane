import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { REMOTE_LOCATOR_PREFIX } from "@/lib/paths";
import { focusRing } from "@/lib/ui";
import { remoteSessionOf, useRemoteSessions, type RemoteSession } from "@/store/remoteSessions";
import { useUi } from "@/store/ui";
import {
  DIALOG_LAYER,
  DialogCancelButton,
  DialogFooter,
  DialogPrimaryButton,
  DialogTitle,
  DialogValidationError,
  ModalFrame,
} from "./frame";

const field = cn(
  "mt-1 h-9 w-full rounded-lg border border-black/10 bg-transparent px-3 text-[13.5px] text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100",
  focusRing,
);

/** Why `host` can't be used, or null. `ssh` would read a leading `-` as an
 * option, so it is refused here as well as in the backend. */
export function hostProblem(host: string): string | null {
  if (!host) return null;
  if (host.startsWith("-") || /[\s/]/.test(host)) return "Enter a host name or SSH config alias.";
  return null;
}

/** Why `path` can't be used, or null: the server path must be absolute. */
export function pathProblem(path: string): string | null {
  if (!path) return null;
  if (!path.startsWith("/") || path.startsWith("/~"))
    return "Enter the repository's absolute path on the server (starting with /, without ~).";
  return null;
}

function progressText(host: string, session: RemoteSession | undefined): string {
  if (session?.state === "installing" && session.progress) {
    const verb = session.progress.stage === "downloading" ? "Downloading" : "Uploading";
    return `${verb} GitLane's agent for ${host}… ${session.progress.percent}%`;
  }
  return `Connecting to ${host}…`;
}

/** "Open remote repository…" (remote-ssh-repos): a host from `~/.ssh/config`
 * or typed, and the repository's absolute path on it. Connecting first (which
 * installs the agent when the server has none) surfaces auth, host-key and
 * platform problems here, before a tab exists. */
export function OpenRemoteDialog() {
  const request = useUi((s) => s.openRemote);
  const close = useUi((s) => s.closeOpenRemote);
  const sshHosts = useRemoteSessions((s) => s.sshHosts);
  const loadSshHosts = useRemoteSessions((s) => s.loadSshHosts);
  const connect = useRemoteSessions((s) => s.connect);
  const [host, setHost] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedHost = host.trim();
  const session = useRemoteSessions(remoteSessionOf(`${REMOTE_LOCATOR_PREFIX}${trimmedHost}`));

  useEffect(() => {
    if (!request) return;
    setHost("");
    setPath("");
    setBusy(false);
    setError(null);
    void loadSshHosts();
  }, [request, loadSshHosts]);

  if (!request) return null;

  const trimmedPath = path.trim();
  const problem = hostProblem(trimmedHost) ?? pathProblem(trimmedPath);
  const canOpen = !busy && trimmedHost !== "" && trimmedPath !== "" && problem === null;

  const open = async () => {
    if (!canOpen) return;
    const locator = `${REMOTE_LOCATOR_PREFIX}${trimmedHost}${trimmedPath}`;
    setBusy(true);
    setError(null);
    try {
      await connect(locator);
      const onOpen = request.onOpen;
      close();
      onOpen(locator);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <ModalFrame z={DIALOG_LAYER.Top} label="Open remote repository" busy={busy} onDismiss={close}>
      <DialogTitle>
        Open remote repository{" "}
        <span className="ml-1 rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 align-middle text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--accent)]">
          Beta
        </span>
      </DialogTitle>
      <div className="mt-1 text-[12.5px] leading-relaxed text-neutral-400">
        A repository on a Linux server you reach over SSH. GitLane uses your SSH keys or agent and
        installs a small helper in your home directory there; the code stays on the server.
      </div>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void open();
        }}
      >
        <label className="text-[12px] font-medium text-neutral-500 dark:text-neutral-400">
          Host
          <input
            autoFocus
            list="open-remote-hosts"
            value={host}
            disabled={busy}
            onChange={(e) => setHost(e.target.value)}
            placeholder="devbox or user@server.example"
            className={field}
          />
          <datalist id="open-remote-hosts">
            {sshHosts.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </label>
        <label className="text-[12px] font-medium text-neutral-500 dark:text-neutral-400">
          Repository path on the server
          <input
            value={path}
            disabled={busy}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/you/project"
            className={cn(field, "font-mono")}
          />
        </label>
        {/* Enter submits from either field. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
      {problem && <DialogValidationError>{problem}</DialogValidationError>}
      {error && <DialogValidationError>{error}</DialogValidationError>}
      {busy && (
        <div role="status" className="mt-3 text-[12.5px] text-neutral-500 dark:text-neutral-400">
          {progressText(trimmedHost, session)}
        </div>
      )}
      <DialogFooter>
        <DialogCancelButton onClick={close} />
        <DialogPrimaryButton onClick={() => void open()} disabled={!canOpen}>
          {busy ? "Connecting…" : "Open"}
        </DialogPrimaryButton>
      </DialogFooter>
    </ModalFrame>
  );
}
