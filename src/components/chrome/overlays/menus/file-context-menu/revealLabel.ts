import { isMac, isWindows } from "@/lib/platform";

/** Platform wording for the "show this path in the OS file browser" row. */
export const revealLabel = isMac ? "Show in Finder" : isWindows ? "Show in Explorer" : "Show in file manager";
