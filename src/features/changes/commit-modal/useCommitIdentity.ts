// Commit-composer identity view-model (GL-213). Owns the identity load + apply
// state and derives the effective author / usability, so the composer can
// read `usable` directly (gating Commit / Commit-with-agent) and hand the model
// to the presentational selector — no child→parent callback effect needed.

import { useEffect, useState } from "react";

import { type RepoIdentity } from "@/lib/api";
import { selectCommitSource } from "@/lib/identities";
import { type GitProfile } from "@/lib/profiles";
import { useAccounts } from "@/store/accounts";
import { appliedCommitSource, useIdentities } from "@/store/identities";

export interface CommitIdentityModel {
  loading: boolean;
  applying: boolean;
  error: string | null;
  /** True once a usable name+email exists and no apply is in flight. */
  usable: boolean;
  effective: RepoIdentity | null;
  /** `name · email` (or a load/warning message). */
  identityText: string;
  /** The source label ("This computer" / a card label / "Custom identity"). */
  sourceLabel: string;
  selection: ReturnType<typeof selectCommitSource>;
  activeManual: GitProfile | null;
  manuals: GitProfile[];
  defaultIdentity: RepoIdentity | null;
  /** Apply a card (or `null` = this computer); never throws. */
  apply: (ref: { kind: "manual"; id: string } | null) => Promise<void>;
}

export function useCommitIdentity(): CommitIdentityModel {
  const repoIdentity = useAccounts((s) => s.repoIdentity);
  const manuals = useIdentities((s) => s.manualIdentities);
  const defaultIdentity = useIdentities((s) => s.defaultIdentity);
  const loadIdentities = useIdentities((s) => s.loadIdentities);
  const loadDefaultIdentity = useIdentities((s) => s.loadDefaultIdentity);
  const applyCommitSource = useIdentities((s) => s.applyCommitSource);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadIdentities();
    void loadDefaultIdentity()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [loadDefaultIdentity, loadIdentities]);

  const selection = selectCommitSource(repoIdentity, manuals, appliedCommitSource(), defaultIdentity);
  const activeManual =
    selection.kind === "manual" ? manuals.find((p) => p.id === selection.id) ?? null : null;
  const effective = repoIdentity ?? defaultIdentity;
  const hasEffective = Boolean(effective?.name?.trim() && effective?.email?.trim());
  // Committable as soon as we know a usable name+email — a pinned repo identity
  // doesn't wait on the global-config load; only an apply-in-flight blocks.
  const usable = hasEffective && !applying;

  const sourceLabel =
    selection.kind === "manual"
      ? activeManual?.label ?? "Custom identity"
      : selection.kind === "unmanaged"
        ? "Custom identity"
        : "This computer";
  const identityText =
    loading && !effective
      ? "Loading Git identity…"
      : effective
        ? `${effective.name || "No name set"} · ${effective.email || "No email set"}`
        : "Set Git user.name and user.email before committing";

  const apply = async (ref: { kind: "manual"; id: string } | null) => {
    setApplying(true);
    setError(null);
    try {
      const applied = await applyCommitSource(ref);
      if (!applied) setError("Could not apply this identity. The current Git identity is unchanged.");
    } catch {
      setError("Could not apply this identity. The current Git identity is unchanged.");
    } finally {
      setApplying(false);
    }
  };

  return {
    loading,
    applying,
    error,
    usable,
    effective,
    identityText,
    sourceLabel,
    selection,
    activeManual,
    manuals,
    defaultIdentity,
    apply,
  };
}
