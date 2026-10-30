import { useState } from "react";
import { cn } from "@/lib/cn";
import { REMOTE_LOCATOR_PREFIX } from "@/lib/paths";
import { focusRing } from "@/lib/ui";
import { useRemoteSessions } from "@/store/remoteSessions";
import type { SshPromptEvent } from "@/lib/api";
import {
  DIALOG_LAYER,
  DialogCancelButton,
  DialogFooter,
  DialogPrimaryButton,
  DialogTitle,
  ModalFrame,
} from "@/components/chrome/overlays/dialogs/frame";

/** The `SHA256:…` fingerprint in ssh's unknown-host question, if present. */
export function fingerprintOf(prompt: string): string | null {
  // OpenSSH 10 writes "fingerprint is: SHA256:…", older ones "is SHA256:….".
  return prompt.match(/fingerprint is:?\s+(\S+?)\.?\s*$/m)?.[1] ?? null;
}

/** A question `ssh` asked while connecting to a remote repository's host
 * (remote-ssh-repos D4): trust a new host key, or a password / passphrase /
 * one-time code. Shown above everything, including the restoring workspace.
 * The typed answer lives only in this component until it is sent. */
export function SshPromptDialog() {
  const prompt = useRemoteSessions((s) => s.prompts[0]);
  if (!prompt) return null;
  // Keyed by id so the next question starts with an empty field.
  return <PromptPanel key={prompt.id} prompt={prompt} />;
}

function PromptPanel({ prompt }: { prompt: SshPromptEvent }) {
  const answerPrompt = useRemoteSessions((s) => s.answerPrompt);
  const [answer, setAnswer] = useState("");
  const host = prompt.origin.slice(REMOTE_LOCATOR_PREFIX.length);
  const cancel = () => void answerPrompt(prompt.id, null);

  if (prompt.kind === "hostKey") {
    const fingerprint = fingerprintOf(prompt.prompt);
    return (
      <ModalFrame z={DIALOG_LAYER.Top} label={`Trust ${host}?`} backdropDismiss={false} onDismiss={cancel}>
        <DialogTitle>Trust {host}?</DialogTitle>
        <div className="mt-2 text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          This computer hasn't connected to {host} before. If you can, check that the server's key
          fingerprint matches before trusting it. GitLane adds it to your SSH known hosts, the same
          as answering “yes” in a terminal.
        </div>
        {fingerprint && (
          <div className="mt-3 break-all rounded-lg bg-black/[0.04] px-3 py-2 font-mono text-[12px] text-neutral-700 dark:bg-white/[0.06] dark:text-neutral-200">
            {fingerprint}
          </div>
        )}
        <details className="mt-2 text-[12px] text-neutral-400">
          <summary className={cn("cursor-pointer select-none", focusRing)}>What ssh said</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11.5px]">{prompt.prompt.trim()}</pre>
        </details>
        <DialogFooter>
          <DialogCancelButton onClick={cancel} />
          <DialogPrimaryButton autoFocus onClick={() => void answerPrompt(prompt.id, "yes")}>
            Trust and connect
          </DialogPrimaryButton>
        </DialogFooter>
      </ModalFrame>
    );
  }

  const submit = () => void answerPrompt(prompt.id, answer);
  return (
    <ModalFrame z={DIALOG_LAYER.Top} label={`Sign in to ${host}`} backdropDismiss={false} onDismiss={cancel}>
      <DialogTitle>Sign in to {host}</DialogTitle>
      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="text-[12.5px] text-neutral-500 dark:text-neutral-400">
          {prompt.prompt.trim()}
          <input
            type="password"
            autoFocus
            autoComplete="off"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            className={cn(
              "mt-1 h-9 w-full rounded-lg border border-black/10 bg-transparent px-3 text-[13.5px] text-neutral-800 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100",
              focusRing,
            )}
          />
        </label>
        <div className="mt-2 text-[12px] text-neutral-400">
          GitLane passes this to ssh for this connection only and doesn't save it.
        </div>
      </form>
      <DialogFooter>
        <DialogCancelButton onClick={cancel} />
        <DialogPrimaryButton onClick={submit}>Continue</DialogPrimaryButton>
      </DialogFooter>
    </ModalFrame>
  );
}
