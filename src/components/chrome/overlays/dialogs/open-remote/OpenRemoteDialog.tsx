import { useEffect, useState } from "react";
import { REMOTE_LOCATOR_PREFIX } from "@/lib/paths";
import { remoteSessionOf, useRemoteSessions, type RemoteSession } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import {
  DIALOG_LAYER,
  DialogCancelButton,
  DialogFooter,
  DialogPrimaryButton,
  DialogTitle,
  DialogValidationError,
  ModalFrame,
} from "@/components/chrome/overlays/dialogs/frame";
import { FolderBrowser } from "./FolderBrowser";
import { HostStep } from "./HostStep";
import { EMPTY_HOST, hostFieldsProblem, originOf, recentOrigins, type HostFields } from "./model";

function progressText(host: string, session: RemoteSession | undefined): string {
  if (session?.state === "installing" && session.progress) {
    const verb = session.progress.stage === "downloading" ? "Downloading" : "Uploading";
    return `${verb} GitLane's helper for ${host}… ${session.progress.percent}%`;
  }
  return `Connecting to ${host}…`;
}

/** "Open remote repository…" (remote-ssh-repos), in two steps: pick the host
 * (connecting surfaces sign-in questions, the helper install and errors before
 * any tab exists), then browse its folders and pick a repository. */
export function OpenRemoteDialog() {
  const request = useUi((s) => s.openRemote);
  const close = useUi((s) => s.closeOpenRemote);
  const sshHosts = useRemoteSessions((s) => s.sshHosts);
  const loadSshHosts = useRemoteSessions((s) => s.loadSshHosts);
  const connect = useRemoteSessions((s) => s.connect);
  const recents = useRepo((s) => s.recents);
  const [fields, setFields] = useState<HostFields>(EMPTY_HOST);
  // Set once connected: the browse step's host and folder.
  const [browse, setBrowse] = useState<{ origin: string; dir: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const origin = originOf(fields);
  const session = useRemoteSessions(remoteSessionOf(origin));

  useEffect(() => {
    if (!request) return;
    setFields(EMPTY_HOST);
    setBrowse(null);
    setBusy(false);
    setError(null);
    void loadSshHosts();
  }, [request, loadSshHosts]);

  if (!request) return null;

  const problem = hostFieldsProblem(fields);
  const canConnect = !busy && fields.host.trim() !== "" && problem === null;
  const host = fields.host.trim();

  const connectHost = async () => {
    if (!canConnect) return;
    setBusy(true);
    setError(null);
    try {
      const reached = await connect(`${origin}/`);
      setBrowse({ origin, dir: reached.home ?? "/" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const open = (path: string) => {
    const onOpen = request.onOpen;
    close();
    onOpen(`${browse?.origin ?? origin}${path}`);
  };

  return (
    <ModalFrame
      z={DIALOG_LAYER.Top}
      label="Open remote repository"
      panelClassName="w-[520px]"
      busy={busy}
      onDismiss={close}
    >
      <DialogTitle>
        Open remote repository{" "}
        <span className="ml-1 rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 align-middle text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--accent)]">
          Beta
        </span>
      </DialogTitle>
      <div className="mt-1 text-[12.5px] leading-relaxed text-neutral-400">
        {browse
          ? `Pick a repository on ${browse.origin.slice(REMOTE_LOCATOR_PREFIX.length)}. Repositories are marked; the code stays on the server.`
          : "A repository on a Linux server you reach over SSH. GitLane installs a small helper in your home directory there; the code stays on the server."}
      </div>
      {browse ? (
        <FolderBrowser
          origin={browse.origin}
          dir={browse.dir}
          onNavigate={(dir) => setBrowse({ ...browse, dir })}
          onOpen={open}
        />
      ) : (
        <HostStep
          fields={fields}
          onChange={setFields}
          recent={recentOrigins(recents.map((r) => r.path))}
          sshHosts={sshHosts}
          busy={busy}
          onSubmit={() => void connectHost()}
        />
      )}
      {!browse && problem && <DialogValidationError>{problem}</DialogValidationError>}
      {error && <DialogValidationError>{error}</DialogValidationError>}
      {busy && (
        <div role="status" className="mt-3 text-[12.5px] text-neutral-500 dark:text-neutral-400">
          {progressText(host, session)}
        </div>
      )}
      <DialogFooter>
        {browse ? (
          <>
            <DialogCancelButton onClick={() => setBrowse(null)}>Change host</DialogCancelButton>
            <DialogPrimaryButton onClick={() => open(browse.dir)}>Open this folder</DialogPrimaryButton>
          </>
        ) : (
          <>
            <DialogCancelButton onClick={close} />
            <DialogPrimaryButton onClick={() => void connectHost()} disabled={!canConnect}>
              {busy ? "Connecting…" : "Connect"}
            </DialogPrimaryButton>
          </>
        )}
      </DialogFooter>
    </ModalFrame>
  );
}
