import { basename } from "@/lib/paths";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { type MenuItem } from "@/components/chrome/overlays/shared";
import { anchoredIgnorePath, ignorePatternChoices } from "@/features/changes/ignorePatterns";

/** The Ignore… submenu builder shared by the file and directory menus. */
export function useIgnoreSubmenu(path: string) {
  const close = useUi((s) => s.closeOverlays);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const appendIgnorePattern = useRepo((s) => s.appendIgnorePattern);
  const fileName = basename(path);

  const applyIgnore = (pattern: string, local: boolean) => {
    close();
    void appendIgnorePattern(pattern, local);
  };

  const ignoreSubmenu = (opts?: { dir?: boolean }): MenuItem[] => {
    const items: MenuItem[] = ignorePatternChoices(path, opts).map((choice) => ({
      label: choice.label,
      onClick: () => applyIgnore(choice.pattern, choice.local),
    }));
    const customDefault = opts?.dir ? `${anchoredIgnorePath(path)}/` : fileName;
    items.push({
      label: "Custom pattern…",
      onClick: () =>
        requestPrompt({
          title: "Ignore pattern",
          message: "Appended to the repository’s root .gitignore.",
          placeholder: "*.log",
          confirmLabel: "Ignore",
          defaultValue: customDefault,
          onSubmit: (pattern) => {
            void appendIgnorePattern(pattern, false);
          },
        }),
    });
    return items;
  };

  return ignoreSubmenu;
}
