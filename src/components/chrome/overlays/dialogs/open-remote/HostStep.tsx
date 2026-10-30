import { cn } from "@/lib/cn";
import { REMOTE_LOCATOR_PREFIX } from "@/lib/paths";
import { focusRing } from "@/lib/ui";
import { ClockIcon, ServerIcon } from "@/components/ui/icons";
import { fieldsOf, type HostFields } from "./model";

export const fieldClass = cn(
  "mt-1 h-9 w-full rounded-lg border border-black/10 bg-transparent px-3 text-[13.5px] text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-[color:var(--accent)] disabled:opacity-60 dark:border-white/10 dark:text-neutral-100",
  focusRing,
);

const labelClass = "text-[12px] font-medium text-neutral-500 dark:text-neutral-400";

/** Step one: which machine. Recent hosts and SSH config hosts fill the form in
 * one click; the fields take anything else. */
export function HostStep({
  fields,
  onChange,
  recent,
  sshHosts,
  busy,
  onSubmit,
}: {
  fields: HostFields;
  onChange: (fields: HostFields) => void;
  recent: string[];
  sshHosts: string[];
  busy: boolean;
  onSubmit: () => void;
}) {
  const suggestions = [
    ...recent.map((origin) => ({ key: origin, label: origin.slice(REMOTE_LOCATOR_PREFIX.length), recent: true })),
    ...sshHosts
      .filter((h) => !recent.some((origin) => fieldsOf(origin).host === h))
      .map((h) => ({ key: h, label: h, recent: false })),
  ];
  return (
    <>
      {suggestions.length > 0 && (
        <ul aria-label="Suggested hosts" className="mt-4 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
          {suggestions.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onChange(s.recent ? fieldsOf(s.key) : { host: s.key, user: "", port: "" })}
                title={s.recent ? "Opened before" : "From your SSH config"}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md border border-black/10 px-2 text-[12.5px] text-neutral-600 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5",
                  focusRing,
                )}
              >
                {s.recent ? (
                  <ClockIcon className="h-3 w-3 text-neutral-400" />
                ) : (
                  <ServerIcon className="h-3 w-3 text-neutral-400" />
                )}
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-4 grid grid-cols-[1fr_7rem_5rem] gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <label className={labelClass}>
          Host
          <input
            autoFocus
            value={fields.host}
            disabled={busy}
            onChange={(e) => onChange({ ...fields, host: e.target.value })}
            placeholder="devbox or server.example.com"
            className={fieldClass}
          />
        </label>
        <label className={labelClass}>
          User
          <input
            value={fields.user}
            disabled={busy}
            onChange={(e) => onChange({ ...fields, user: e.target.value })}
            placeholder="optional"
            className={fieldClass}
          />
        </label>
        <label className={labelClass}>
          Port
          <input
            value={fields.port}
            disabled={busy}
            inputMode="numeric"
            onChange={(e) => onChange({ ...fields, port: e.target.value })}
            placeholder="22"
            className={fieldClass}
          />
        </label>
        {/* Enter submits from any field. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </>
  );
}
