import { useEffect, useState } from "react";
import { REMOTE_LOCATOR_PREFIX } from "@/lib/paths";
import { connectionOrigin, remoteSessionOf, useRemoteSessions, type RemoteSession } from "@/store/remoteSessions";
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
import { ConnectionForm } from "./ConnectionForm";
import { FolderBrowser } from "./FolderBrowser";
import { HostPicker } from "./HostPicker";

function progressText(host: string, session: RemoteSession | undefined): string {
  if (session?.state === "installing" && session.progress) {
    const verb = session.progress.stage === "downloading" ? "Downloading" : "Uploading";
    return `${verb} GitLane's helper for ${host}… ${session.progress.percent}%`;
  }
  return `Connecting to ${host}…`;
}

type Step =
  | { kind: "pick" }
  | { kind: "add" }
  | { kind: "connecting"; origin: string }
  | { kind: "browse"; origin: string; dir: string };

/** "Open remote repository…" (remote-ssh-repos): pick a saved connection, an
 * SSH config host, or add a connection; connecting surfaces sign-in
 * questions, the helper install and errors before any tab exists; then browse
 * the server's folders and pick a repository. */
export function OpenRemoteDialog() {
  const request = useUi((s) => s.openRemote);
  const close = useUi((s) => s.closeOpenRemote);
  const sshHosts = useRemoteSessions((s) => s.sshHosts);
  const connections = useRemoteSessions((s) => s.connections);
  const loadSshHosts = useRemoteSessions((s) => s.loadSshHosts);
  const loadConnections = useRemoteSessions((s) => s.loadConnections);
  const connect = useRemoteSessions((s) => s.connect);
  const releaseUnused = useRemoteSessions((s) => s.releaseUnused);
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [error, setError] = useState<string | null>(null);
  const connectingOrigin = step.kind === "connecting" ? step.origin : "";
  const session = useRemoteSessions(remoteSessionOf(connectingOrigin));

  useEffect(() => {
    if (!request) return;
    setStep({ kind: "pick" });
    setError(null);
    void loadSshHosts();
    void loadConnections();
  }, [request, loadSshHosts, loadConnections]);

  if (!request) return null;

  const nameOf = (origin: string) =>
    connections.find((c) => connectionOrigin(c) === origin)?.name ?? origin.slice(REMOTE_LOCATOR_PREFIX.length);

  const pick = async (origin: string) => {
    setError(null);
    setStep({ kind: "connecting", origin });
    try {
      const reached = await connect(`${origin}/`);
      setStep({ kind: "browse", origin, dir: reached.home ?? "/" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep({ kind: "pick" });
    }
  };

  // Leaving without opening must not strand the session the dialog started.
  const dismiss = () => {
    if (step.kind === "browse") void releaseUnused(step.origin, useRepo.getState().openPaths);
    close();
  };

  const open = (origin: string, path: string) => {
    const onOpen = request.onOpen;
    close();
    onOpen(`${origin}${path}`);
  };

  const title = step.kind === "add" ? "Add SSH connection" : "Open remote repository";
  return (
    <ModalFrame
      z={DIALOG_LAYER.Top}
      label={title}
      panelClassName="w-[520px]"
      busy={step.kind === "connecting"}
      backdropDismiss={step.kind !== "add"}
      onDismiss={dismiss}
    >
      <DialogTitle>
        {title}
        {step.kind !== "add" && (
          <span className="ml-2 rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 align-middle text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--accent)]">
            Beta
          </span>
        )}
      </DialogTitle>
      <div className="mt-1 text-[12.5px] leading-relaxed text-neutral-400">
        {step.kind === "browse"
          ? `Pick a repository on ${nameOf(step.origin)}. Repositories are marked; the code stays on the server.`
          : step.kind === "add"
            ? "Connect to a Linux server to work on its repositories. GitLane uses your own ssh."
            : "A repository on a Linux server you reach over SSH. GitLane installs a small helper in your home folder there; the code stays on the server."}
      </div>

      {step.kind === "add" && (
        <ConnectionForm
          editing={null}
          onSaved={(c) => void pick(connectionOrigin(c))}
          onCancel={() => setStep({ kind: "pick" })}
        />
      )}
      {(step.kind === "pick" || step.kind === "connecting") && (
        <HostPicker
          connections={connections}
          sshHosts={sshHosts}
          busy={step.kind === "connecting"}
          onPick={(origin) => void pick(origin)}
          onAdd={() => setStep({ kind: "add" })}
        />
      )}
      {step.kind === "browse" && (
        <FolderBrowser
          origin={step.origin}
          dir={step.dir}
          onNavigate={(dir) => setStep({ ...step, dir })}
          onOpen={(path) => open(step.origin, path)}
        />
      )}

      {error && <DialogValidationError>{error}</DialogValidationError>}
      {step.kind === "connecting" && (
        <div role="status" className="mt-3 text-[12.5px] text-neutral-500 dark:text-neutral-400">
          {progressText(nameOf(step.origin), session)}
        </div>
      )}
      {step.kind !== "add" && (
        <DialogFooter>
          {step.kind === "browse" ? (
            <>
              <DialogCancelButton
                onClick={() => {
                  void releaseUnused(step.origin, useRepo.getState().openPaths);
                  setStep({ kind: "pick" });
                }}
              >
                Change host
              </DialogCancelButton>
              <DialogPrimaryButton onClick={() => open(step.origin, step.dir)}>Open this folder</DialogPrimaryButton>
            </>
          ) : (
            <DialogCancelButton onClick={dismiss} />
          )}
        </DialogFooter>
      )}
    </ModalFrame>
  );
}
