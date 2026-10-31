// The What's new dialog, opened from the titlebar update indicator: the release
// notes for every version between the running build and the offered one, plus
// the action that fits the update's state. All state + plugin calls live in
// `useUpdates`; Settings → About shows the same flow as a card.

import {
  DIALOG_LAYER,
  DialogCancelButton,
  DialogPrimaryButton,
  DialogTitle,
  ModalFrame,
} from "@/components/chrome/overlays/dialogs/frame";
import { useUi } from "@/store/ui";
import { useUpdates } from "@/store/updates";
import { ReleaseNotesList } from "./ReleaseNotesList";
import { DownloadProgress, quietButton, useOfferedIsSkipped } from "./shared";

const Footer = ({ onClose }: { onClose: () => void }) => {
  const status = useUpdates((s) => s.status);
  const update = useUpdates((s) => s.update);
  const error = useUpdates((s) => s.error);
  const skip = useUpdates((s) => s.skip);
  const downloadAndInstall = useUpdates((s) => s.downloadAndInstall);
  const restart = useUpdates((s) => s.restart);
  const skipped = useOfferedIsSkipped();

  const later = <DialogCancelButton onClick={onClose}>Later</DialogCancelButton>;

  if (status === "available") {
    return (
      <>
        {!skipped && (
          <button type="button" className={quietButton} onClick={() => void skip()}>
            Skip this version
          </button>
        )}
        <div className="flex-1" />
        {later}
        <DialogPrimaryButton onClick={() => void downloadAndInstall()}>Install update</DialogPrimaryButton>
      </>
    );
  }
  if (status === "downloading") {
    return (
      <>
        <div className="min-w-0 flex-1">
          <DownloadProgress />
        </div>
        <DialogCancelButton onClick={onClose}>Hide</DialogCancelButton>
      </>
    );
  }
  if (status === "ready") {
    return (
      <>
        <span className="text-[12.5px] text-emerald-600 dark:text-emerald-400">Installed — restart to finish</span>
        <div className="flex-1" />
        {later}
        <DialogPrimaryButton onClick={() => void restart()}>Relaunch</DialogPrimaryButton>
      </>
    );
  }
  if (status === "error" && update !== null) {
    return (
      <>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-rose-600 dark:text-rose-400" title={error ?? undefined}>
          Download failed{error ? `: ${error}` : ""}
        </span>
        {later}
        <DialogPrimaryButton onClick={() => void downloadAndInstall()}>Retry download</DialogPrimaryButton>
      </>
    );
  }
  return (
    <>
      <div className="flex-1" />
      <DialogCancelButton onClick={onClose}>Close</DialogCancelButton>
    </>
  );
};

export const WhatsNewDialog = () => {
  const open = useUi((s) => s.whatsNewOpen);
  const close = useUi((s) => s.closeWhatsNew);
  const beta = useUi((s) => s.betaUpdates);
  const version = useUpdates((s) => s.version);
  const newVersion = useUpdates((s) => s.newVersion);
  const update = useUpdates((s) => s.update);

  if (!open) return null;
  const from = update?.currentVersion || version;

  return (
    <ModalFrame
      z={DIALOG_LAYER.Base}
      label="What's new"
      bare
      panelClassName="flex max-h-[min(640px,calc(100vh-56px))] w-[min(560px,calc(100vw-48px))] flex-col"
      onDismiss={close}
    >
      <div className="border-b border-black/10 px-5 py-4 dark:border-white/10">
        <DialogTitle>What's new</DialogTitle>
        {newVersion && (
          <div className="mt-1 flex items-center gap-2 text-[12.5px] text-neutral-500 dark:text-neutral-400">
            <span>
              GitLane {from ? `${from} → ` : ""}
              {newVersion}
            </span>
            {beta && (
              <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[11px] font-medium text-neutral-600 dark:bg-white/10 dark:text-neutral-300">
                Beta
              </span>
            )}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {newVersion ? (
          <ReleaseNotesList />
        ) : (
          <div className="text-[13px] text-neutral-500 dark:text-neutral-400">No update is waiting.</div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-black/10 px-5 py-3 dark:border-white/10">
        <Footer onClose={close} />
      </div>
    </ModalFrame>
  );
};
