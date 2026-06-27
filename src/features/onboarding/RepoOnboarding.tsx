// Repository onboarding (GL-38) — the start-state experience shown when no repo
// is open. A small state machine (useOnboarding) drives seven screens: pick an
// action + recents (home), the clone form → live progress → error/success, and
// the init form → empty-repo success. Replaces the old minimal WelcomeScreen.

import { CloneForm } from "./CloneForm";
import { CloneProgress } from "./CloneProgress";
import { HomeScreen } from "./HomeScreen";
import { InitForm } from "./InitForm";
import { OnboardingError } from "./OnboardingError";
import { OnboardingSuccess } from "./OnboardingSuccess";
import { useOnboarding } from "./useOnboarding";

export function RepoOnboarding() {
  const ob = useOnboarding();

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      {ob.screen === "home" && <HomeScreen ob={ob} />}
      {ob.screen === "clone" && <CloneForm ob={ob} />}
      {ob.screen === "progress" && <CloneProgress ob={ob} />}
      {ob.screen === "error" && <OnboardingError ob={ob} />}
      {ob.screen === "init" && <InitForm ob={ob} />}
      {(ob.screen === "empty" || ob.screen === "opened") && <OnboardingSuccess ob={ob} />}
    </main>
  );
}
