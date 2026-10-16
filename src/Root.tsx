import App from "./App";
import { cn } from "./lib/cn";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { ErrorFallback } from "./components/ui/ErrorFallback";
import { useResolvedTheme } from "./hooks/useResolvedTheme";

/** Full-window crash screen. App's `.dark` root is gone by now, so it applies
 * the resolved theme itself rather than flashing light in dark mode. */
const RootFallback = ({ message }: { message: string }) => {
  const theme = useResolvedTheme();
  return (
    <div className={cn(theme === "dark" && "dark")}>
      <ErrorFallback
        message={`GitLane hit an error.\n${message}`}
        onRetry={() => window.location.reload()}
        retryLabel="Reload"
        className="h-screen bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300"
      />
    </div>
  );
};

/** The last-resort boundary: a render error that escapes every narrower one
 * shows a full-window Reload screen instead of an empty window background. */
export const Root = () => (
  <ErrorBoundary fallback={({ error }) => <RootFallback message={error.message} />}>
    <App />
  </ErrorBoundary>
);
