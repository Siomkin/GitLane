// Repository onboarding (GL-38). Shown two ways:
//  - as the start-state experience when no repo is open (App renders it inline), and
//  - as a dismissible overlay raised from the tab strip's "+" while a repo is
//    open (`onClose` set) so clone / init / open are reachable mid-session.
// A small state machine (useOnboarding) drives seven screens: pick an action +
// recents (home), the clone form → live progress → error/success, and the init
// form → empty-repo success.

import { useEffect } from "react";
import { CloneForm } from "./screens/CloneForm";
import { CloneProgress } from "./screens/CloneProgress";
import { HomeScreen } from "./screens/HomeScreen";
import { InitForm } from "./screens/InitForm";
import { OnboardingError } from "./screens/OnboardingError";
import { OnboardingSuccess } from "./screens/OnboardingSuccess";
import { ChevronLeft } from "./icons";
import { useOnboarding } from "./flows/useOnboarding";

export const RepoOnboarding = ({ onClose }: { onClose?: () => void }) => {
  // In overlay mode, opening a repo (or pressing the action) dismisses the overlay.
  const ob = useOnboarding(onClose);

  // Escape closes the overlay (no-op in inline start-state mode).
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const body = (
    <>
      {ob.screen === "home" && <HomeScreen ob={ob} />}
      {ob.screen === "clone" && <CloneForm ob={ob} />}
      {ob.screen === "progress" && <CloneProgress ob={ob} />}
      {ob.screen === "error" && <OnboardingError ob={ob} />}
      {ob.screen === "init" && <InitForm ob={ob} />}
      {(ob.screen === "empty" || ob.screen === "opened") && <OnboardingSuccess ob={ob} />}
    </>
  );

  // Inline start-state: fill the area App reserves when no repo is open.
  if (!onClose) {
    return <main className="min-h-0 flex-1 overflow-y-auto">{body}</main>;
  }

  // Overlay: a solid panel below the title bar (so tabs + window controls stay
  // usable as the way back), with an explicit Close affordance.
  return (
    <div className="fixed inset-x-0 bottom-0 top-12 z-40 flex flex-col bg-neutral-100 dark:bg-neutral-900">
      <div className="flex shrink-0 items-center border-b border-black/5 px-4 py-2 dark:border-white/5">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-neutral-500 hover:bg-black/5 hover:text-neutral-800 dark:hover:bg-white/5 dark:hover:text-neutral-200"
        >
          <ChevronLeft className="h-4 w-4" />
          Close
        </button>
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto">{body}</main>
    </div>
  );
};
