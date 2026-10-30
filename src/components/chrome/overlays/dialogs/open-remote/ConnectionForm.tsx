import { useState } from "react";
import type { SshConnection } from "@/lib/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { connectionOrigin, useRemoteSessions } from "@/store/remoteSessions";
import {
  DialogCancelButton,
  DialogFooter,
  DialogPrimaryButton,
  DialogValidationError,
} from "@/components/chrome/overlays/dialogs/frame";
import { connectionOf, EMPTY_FORM, formOf, formProblem, type ConnectionForm as Form } from "./model";

export const fieldClass = cn(
  "mt-1 h-9 w-full rounded-lg border border-black/10 bg-transparent px-3 text-[13.5px] text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-[color:var(--accent)] disabled:opacity-60 dark:border-white/10 dark:text-neutral-100",
  focusRing,
);
const labelClass = "block text-[12.5px] font-medium text-neutral-600 dark:text-neutral-300";
const hintClass = "mt-1 text-[12px] text-neutral-400";

type TestState = { state: "idle" } | { state: "testing" } | { state: "ok"; detail: string } | { state: "failed"; message: string };

/** Add or edit a saved SSH connection (remote-ssh-repos D11), modelled on
 * Claude's own "Add SSH connection": a name, host, port and key file, and a
 * Test that connects (sign-in questions included) without saving anything. */
export function ConnectionForm({
  editing,
  onSaved,
  onCancel,
}: {
  /** The connection being edited, or null to add one. */
  editing: SshConnection | null;
  onSaved: (connection: SshConnection) => void;
  onCancel: () => void;
}) {
  const saveConnection = useRemoteSessions((s) => s.saveConnection);
  const testConnection = useRemoteSessions((s) => s.testConnection);
  const [form, setForm] = useState<Form>(editing ? formOf(editing) : EMPTY_FORM);
  const [test, setTest] = useState<TestState>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = formProblem(form, { needName: true });
  const testProblem = formProblem(form, { needName: false });
  const update = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch });
    setTest({ state: "idle" });
    setError(null);
  };

  const runTest = async () => {
    const connection = connectionOf(form);
    const origin = connectionOrigin(connection);
    setTest({ state: "testing" });
    try {
      const host = await testConnection(`${origin}/`, connection.identityFile);
      setTest({ state: "ok", detail: host.git ?? "Connected" });
    } catch (e) {
      setTest({ state: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const connection = connectionOf(form);
      await saveConnection(editing ? connectionOrigin(editing) : null, connection);
      onSaved(connection);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <>
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem && !saving) void save();
        }}
      >
        <label className={labelClass}>
          Name
          <input
            autoFocus
            value={form.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="Work laptop"
            className={fieldClass}
          />
          <div className={hintClass}>A friendly name, shown in the toolbar for this host.</div>
        </label>
        <label className={labelClass}>
          SSH host
          <input
            value={form.host}
            onChange={(e) => update({ host: e.target.value })}
            placeholder="user@hostname"
            className={fieldClass}
          />
          <div className={hintClass}>user@myserver.com, an IP address, or a host from ~/.ssh/config.</div>
        </label>
        <label className={labelClass}>
          SSH port
          <input
            value={form.port}
            inputMode="numeric"
            onChange={(e) => update({ port: e.target.value })}
            placeholder="22"
            className={fieldClass}
          />
          <div className={hintClass}>Leave empty to use 22 or your SSH configuration.</div>
        </label>
        <label className={labelClass}>
          SSH key (optional)
          <input
            value={form.identityFile}
            onChange={(e) => update({ identityFile: e.target.value })}
            placeholder="~/.ssh/server_key"
            className={cn(fieldClass, "font-mono text-[12.5px]")}
          />
          <div className={hintClass}>Path to a private key. Leave empty to use your SSH configuration or agent.</div>
        </label>
        {/* Enter saves from any field. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={!!testProblem || test.state === "testing"}
          onClick={() => void runTest()}
          className={cn(
            "h-8 shrink-0 rounded-lg border border-black/10 px-3 text-[12.5px] hover:bg-black/5 disabled:opacity-45 dark:border-white/10 dark:hover:bg-white/5",
            focusRing,
          )}
        >
          {test.state === "testing" ? "Testing…" : "Test connection"}
        </button>
        <span role="status" className="min-w-0 text-[12.5px]">
          {test.state === "ok" && <span className="text-emerald-600 dark:text-emerald-400">Connected · {test.detail}</span>}
          {test.state === "failed" && <span className="text-rose-500">{test.message}</span>}
        </span>
      </div>

      {form.name && problem && <DialogValidationError>{problem}</DialogValidationError>}
      {error && <DialogValidationError>{error}</DialogValidationError>}
      <DialogFooter>
        <DialogCancelButton onClick={onCancel} />
        <DialogPrimaryButton onClick={() => void save()} disabled={!!problem || saving}>
          {editing ? "Save" : "Add SSH connection"}
        </DialogPrimaryButton>
      </DialogFooter>
    </>
  );
}
