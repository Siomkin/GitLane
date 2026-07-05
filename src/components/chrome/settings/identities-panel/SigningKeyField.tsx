// Signing-key picker for the profile editor (GL-64). Lists the keys the user
// already has (GPG secret keys + SSH public keys, discovered server-side) so
// they pick instead of typing a key id, with a "paste manually" escape hatch.
// References only — the value is a GPG key id or SSH public-key path, never a
// secret. Format is inferred from the chosen key; manual entry exposes a toggle.

import { useEffect, useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
// eslint-disable-next-line no-restricted-imports -- local signing-keys read probe for the key picker (architecture-rules-react.md §1)
import { api, type SigningKey } from "../../../../lib/api";

const MANUAL = "__manual__";

const fieldCls =
  "h-10 rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] text-[13px] text-neutral-900 dark:text-white outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]";

export function SigningKeyField({
  value,
  format,
  onChange,
}: {
  value: string;
  format: "openpgp" | "ssh";
  onChange: (value: string, format: "openpgp" | "ssh") => void;
}) {
  const [keys, setKeys] = useState<SigningKey[]>([]);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .listSigningKeys()
      .then((k) => {
        if (alive && Array.isArray(k)) setKeys(k);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const inList = keys.some((k) => k.value === value);
  const noKeys = keys.length === 0;
  const gpgKeys = keys.filter((k) => k.format === "openpgp");
  const sshKeys = keys.filter((k) => k.format === "ssh");
  // Manual when there are no discovered keys, the user chose to paste, or the
  // current value isn't one of the discovered keys (e.g. seeded manually).
  const showManual = noKeys || manual || (Boolean(value) && !inList);

  const onSelect = (v: string) => {
    if (v === MANUAL) {
      setManual(true);
      return;
    }
    setManual(false);
    if (v === "") {
      onChange("", format);
      return;
    }
    const k = keys.find((key) => key.value === v);
    if (k) onChange(k.value, k.format as "openpgp" | "ssh");
  };

  return (
    <div className="flex flex-col gap-2">
      {!noKeys && (
        <select
          aria-label="Signing key"
          value={showManual ? MANUAL : inList ? value : ""}
          onChange={(e) => onSelect(e.target.value)}
          className={cn(fieldCls, "w-full px-3", focusRing)}
        >
          <option value="">No signing key</option>
          {gpgKeys.length > 0 && (
            <optgroup label="GPG / OpenPGP">
              {gpgKeys.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </optgroup>
          )}
          {sshKeys.length > 0 && (
            <optgroup label="SSH">
              {sshKeys.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </optgroup>
          )}
          <option value={MANUAL}>Paste a key manually…</option>
        </select>
      )}

      {showManual && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <circle cx="7.5" cy="15.5" r="4.5" />
                <path d="m10.6 12.4 8.4-8.4M16 5l3 3M14 7l3 3" />
              </svg>
            </span>
            <input
              value={value}
              onChange={(e) => onChange(e.target.value, format)}
              placeholder="4A9F2C1B7E… or ~/.ssh/id_ed25519.pub"
              className={cn(fieldCls, "w-full pl-9 pr-3.5 font-mono")}
            />
          </div>
          {value.trim() !== "" && (
            <div className="flex h-10 shrink-0 items-center rounded-lg border border-black/10 p-0.5 dark:border-white/10">
              {(["openpgp", "ssh"] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => onChange(value, fmt)}
                  className={cn(
                    "h-full rounded-[7px] px-2.5 text-[12px] font-semibold transition",
                    format === fmt
                      ? "bg-[var(--accent)] text-white"
                      : "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/10",
                    focusRing,
                  )}
                >
                  {fmt === "openpgp" ? "GPG" : "SSH"}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
