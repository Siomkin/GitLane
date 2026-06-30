// Init concern of the onboarding flow: the initialize-repository form (location,
// name, branch, README + .gitignore options) and the init run. Owns only init
// state; transitions the shared screen/result through the injected setters. The
// orchestrator (useOnboarding) composes this with useCloneFlow.

import { useCallback, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
// eslint-disable-next-line no-restricted-imports -- feature hook owning the init flow (architecture-rules-react.md §1)
import { api } from "../../../lib/api";
import {
  type GitignoreTemplate,
  isSafeLeafName,
  type OnboardingResult,
  type OnboardingScreen,
} from "../onboarding";
import { defaultParent } from "./parents";

interface InitFlowDeps {
  setScreen: (screen: OnboardingScreen) => void;
  setResult: (result: OnboardingResult) => void;
}

export const useInitFlow = ({ setScreen, setResult }: InitFlowDeps) => {
  const [initParent, setInitParent] = useState(defaultParent);
  const [initName, setInitName] = useState("my-project");
  const [initBranch, setInitBranch] = useState("main");
  const [initReadme, setInitReadme] = useState(true);
  const [initIgnore, setInitIgnore] = useState<GitignoreTemplate>("None");
  const [initError, setInitError] = useState<string | null>(null);
  const [initBusy, setInitBusy] = useState(false);
  // Synchronous guard against a double-submit firing two init_repo calls before
  // the async `initBusy` state has a chance to disable the button.
  const initBusyRef = useRef(false);

  // Reject `.`/`..`/separators so init always targets a fresh child folder.
  const canInit = initParent.trim() !== "" && isSafeLeafName(initName);

  const browseInitParent = useCallback(() => {
    void (async () => {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") setInitParent(picked);
    })();
  }, []);

  const toggleReadme = useCallback(() => setInitReadme((v) => !v), []);

  const startInit = useCallback(() => {
    if (initBusyRef.current) return;
    if (initParent.trim() === "" || initName.trim() === "") return;
    const name = initName.trim();
    const branch = initBranch.trim() || "main";
    initBusyRef.current = true;
    setInitError(null);
    setInitBusy(true);
    void (async () => {
      try {
        const path = await api.initRepo(initParent, name, branch, initReadme, initIgnore);
        setResult({ name, branch, path });
        setScreen("empty");
      } catch (e) {
        setInitError(String(e));
      } finally {
        initBusyRef.current = false;
        setInitBusy(false);
      }
    })();
  }, [initParent, initName, initBranch, initReadme, initIgnore, setScreen, setResult]);

  /** Open the init form fresh, clearing any prior error. */
  const goInitForm = useCallback(() => {
    setInitError(null);
    setScreen("init");
  }, [setScreen]);

  return {
    initParent,
    browseInitParent,
    initName,
    setInitName,
    initBranch,
    setInitBranch,
    initReadme,
    toggleReadme,
    initIgnore,
    setInitIgnore,
    initError,
    initBusy,
    canInit,
    startInit,
    goInitForm,
  };
};
