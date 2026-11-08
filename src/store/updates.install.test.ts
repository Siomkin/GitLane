// The Windows installer exits the app on its own, so installing there is a quit
// path; elsewhere it only stages the update and `restart` is what leaves.
import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isWindows: false }));
vi.mock("@/lib/platform", async (load) => ({
  ...(await load<typeof import("@/lib/platform")>()),
  get isWindows() {
    return platform.isWindows;
  },
}));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { Update } from "@/lib/updater";
import { useRepo } from "./repo";
import type { FileViewState } from "./repoTypes";
import { useUi } from "./ui";
import { useUpdates } from "./updates";

const DIRTY = {
  path: "a.ts",
  content: { text: "saved" },
  loading: false,
  error: null,
  edit: { draft: "typed", baseSize: 5, baseExpectedState: "s", saving: false },
} as unknown as FileViewState;

const install = vi.fn(async () => {});

beforeEach(() => {
  install.mockClear();
  useUi.setState({ confirm: null });
  useRepo.setState({ fileView: DIRTY });
  useUpdates.setState({
    status: "available",
    update: { downloadAndInstall: install } as unknown as Update,
  });
});

describe("downloadAndInstall with a dirty draft", () => {
  it("asks first on Windows, and installs on confirm", async () => {
    platform.isWindows = true;
    await useUpdates.getState().downloadAndInstall();
    expect(install).not.toHaveBeenCalled();
    expect(useUi.getState().confirm?.title).toBe("Discard unsaved changes?");
    useUi.getState().confirm?.onConfirm();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("just stages the update elsewhere", async () => {
    platform.isWindows = false;
    await useUpdates.getState().downloadAndInstall();
    expect(install).toHaveBeenCalledTimes(1);
    expect(useUi.getState().confirm).toBeNull();
  });
});
