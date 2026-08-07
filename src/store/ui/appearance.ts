// Theme, density, and the per-identity colours the graph paints with. All of it
// is a user preference, so all of it persists and none of it resets on a repo
// switch.
import type { AccentColor } from "@/lib/accent";
import { resolveTheme, systemPrefersDark } from "@/lib/theme";
import { FileListView } from "@/lib/ui";
import { persistedKeys, type SliceSet } from "./slice";

export type Theme = "dark" | "light" | "system";
export type Density = "Comfortable" | "Compact";

export interface AppearanceSlice {
  theme: Theme;
  accent: AccentColor;
  density: Density;
  /** Paint author initials / bundled agent marks on commit nodes. When false,
   * GraphLayer bypasses identity resolution and paints the classic dots. */
  showCommitNodeIcons: boolean;
  /** User-chosen identity colours, keyed by lower-cased email. Overrides the
   * deterministic `identityColor` hash wherever a person's avatar is painted
   * (graph node, hover card, commit People rows, author block). */
  identityColors: Record<string, string>;
  /** How file lists are grouped. Shared across the commit / working /
   * merged-selection inspectors and the stacked "review all" ordering so
   * switching in one place is reflected everywhere. */
  fileListView: FileListView;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setAccent: (accent: AccentColor) => void;
  setDensity: (density: Density) => void;
  setFileListView: (view: FileListView) => void;
  setShowCommitNodeIcons: (show: boolean) => void;
  /** Set (colour) or clear (null) the custom colour for an email. */
  setIdentityColor: (email: string, color: string | null) => void;
}

const PERSISTED = [
  "theme",
  "accent",
  "density",
  "showCommitNodeIcons",
  "identityColors",
  "fileListView",
] as const;

export const persistedAppearance = (s: AppearanceSlice) => persistedKeys(s, PERSISTED);

export function createAppearanceSlice(set: SliceSet<AppearanceSlice>): AppearanceSlice {
  return {
    theme: "dark",
    accent: "green",
    density: "Compact",
    showCommitNodeIcons: true,
    identityColors: {},
    fileListView: FileListView.Path,

    setTheme: (theme) => set({ theme }),
    // Quick toggle flips to the opposite of whatever is currently showing — so a
    // `system` preference resolves first, then lands on an explicit dark/light.
    toggleTheme: () =>
      set((s) => ({
        theme: resolveTheme(s.theme, systemPrefersDark()) === "dark" ? "light" : "dark",
      })),
    setAccent: (accent) => set({ accent }),
    setDensity: (density) => set({ density }),
    setFileListView: (view) => set((s) => (s.fileListView === view ? s : { fileListView: view })),
    setShowCommitNodeIcons: (show) => set({ showCommitNodeIcons: show }),
    setIdentityColor: (email, color) =>
      set((s) => {
        const key = email.trim().toLowerCase();
        if (!key) return {};
        const next = { ...s.identityColors };
        if (color) next[key] = color;
        else delete next[key];
        return { identityColors: next };
      }),
  };
}
