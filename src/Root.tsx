import App from "./App";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { ErrorFallback } from "./components/ui/ErrorFallback";

/** The last-resort boundary: a render error that escapes every narrower one
 * shows a full-window Reload screen instead of an empty window background. */
export const Root = () => (
  <ErrorBoundary
    fallback={({ error }) => (
      <ErrorFallback
        message={`GitLane hit an error.\n${error.message}`}
        onRetry={() => window.location.reload()}
        retryLabel="Reload"
        className="h-screen bg-neutral-100 text-neutral-600"
      />
    )}
  >
    <App />
  </ErrorBoundary>
);
