// Update-channel and background-fetch preferences — the About panel's toggles.
import { persistedKeys, type SliceSet } from "./slice";

/** The allowed background-fetch cadences (enable/disable is the separate
 * `autoFetchEnabled` switch, so toggling off keeps the chosen cadence). The
 * persisted value is validated against this list (rehydrated storage can hold
 * anything). */
export const AUTO_FETCH_MINUTES = [5, 15, 30, 60] as const;
export type AutoFetchMinutes = (typeof AUTO_FETCH_MINUTES)[number];
export const DEFAULT_AUTO_FETCH_MINUTES: AutoFetchMinutes = 15;

/** Clamp a (possibly rehydrated) cadence to the allowed list — persisted
 * storage can hold anything, including the pre-toggle 0 sentinel. */
export function sanitizeAutoFetchMinutes(value: number): AutoFetchMinutes {
  return (AUTO_FETCH_MINUTES as readonly number[]).includes(value)
    ? (value as AutoFetchMinutes)
    : DEFAULT_AUTO_FETCH_MINUTES;
}

export interface UpdatePrefsSlice {
  /** When true, GitLane runs a quiet update check at most once a day on launch
   * (the About panel's toggle). `lastUpdateCheckAt` is the epoch ms of the last
   * attempt, used to throttle that daily check. */
  autoCheckUpdates: boolean;
  /** Opt-in background fetch switch (off by default) and its cadence in
   * minutes. Kept separate so disabling preserves the chosen cadence. */
  autoFetchEnabled: boolean;
  autoFetchMinutes: AutoFetchMinutes;
  lastUpdateCheckAt: number;
  /** When true, update checks target the beta channel's rolling manifest
   * instead of the stable `/latest/` endpoint (GL-154, the About panel's
   * "Receive beta updates" toggle). Defaults on for now: no stable release
   * exists yet, so stable can't resolve — and it's self-correcting, the beta
   * manifest rolls forward to a stable build once one ships. */
  betaUpdates: boolean;

  setAutoCheckUpdates: (on: boolean) => void;
  setAutoFetchEnabled: (on: boolean) => void;
  setAutoFetchMinutes: (minutes: AutoFetchMinutes) => void;
  /** Opt into (or out of) beta-channel update checks (GL-154). */
  setBetaUpdates: (on: boolean) => void;
  /** Stamp the last update-check time (called by the updates store on any check). */
  markUpdateChecked: () => void;
}

const PERSISTED = [
  "autoCheckUpdates",
  "autoFetchEnabled",
  "autoFetchMinutes",
  "betaUpdates",
  "lastUpdateCheckAt",
] as const;

export const persistedUpdatePrefs = (s: UpdatePrefsSlice) => persistedKeys(s, PERSISTED);

export function createUpdatePrefsSlice(set: SliceSet<UpdatePrefsSlice>): UpdatePrefsSlice {
  return {
    autoCheckUpdates: true,
    autoFetchEnabled: false,
    autoFetchMinutes: DEFAULT_AUTO_FETCH_MINUTES,
    lastUpdateCheckAt: 0,
    betaUpdates: true,

    setAutoCheckUpdates: (on) => set({ autoCheckUpdates: on }),
    setAutoFetchEnabled: (on) => set({ autoFetchEnabled: on }),
    setAutoFetchMinutes: (minutes) => set({ autoFetchMinutes: sanitizeAutoFetchMinutes(minutes) }),
    setBetaUpdates: (on) => set({ betaUpdates: on }),
    markUpdateChecked: () => set({ lastUpdateCheckAt: Date.now() }),
  };
}
