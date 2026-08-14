import { basename } from "@/lib/paths";
import { CopyIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { type MenuItem } from "@/components/chrome/overlays/shared";

/** The Copy group shared by every file/directory menu variant. */
export function useCopyCluster(path: string) {
  const close = useUi((s) => s.closeOverlays);
  const workdir = useRepo((s) => s.summary?.workdir ?? s.summary?.path ?? "");
  const fileName = basename(path);
  // Absolute path = repo root + repo-relative path (workdir has no trailing slash).
  const fullPath = workdir ? `${workdir.replace(/\/+$/, "")}/${path}` : path;

  const copy = (text: string) => {
    close();
    void navigator.clipboard?.writeText(text);
  };

  // The copy options carry no glyph of their own; reserve the same icon column
  // (w-4 + gap) so their labels align with the icon'd action rows above rather
  // than sitting flush against the panel's left padding.
  const copyIndent = <span className="block h-4 w-4" aria-hidden />;
  // Its own group everywhere it appears — the panel puts the divider above it.
  const copyCluster = (kind: "file" | "folder"): MenuItem[] => [
    { label: "Copy", header: true, icon: <CopyIcon className="h-3.5 w-3.5" /> },
    { label: kind === "folder" ? "Folder name" : "File name", icon: copyIndent, onClick: () => copy(fileName) },
    { label: "Relative path", icon: copyIndent, onClick: () => copy(path) },
    { label: "Full path", icon: copyIndent, onClick: () => copy(fullPath) },
  ];

  return copyCluster;
}
