import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Renders the fallback for a caught render/commit error. `reset()` clears the
   * error so `children` render again and the failed subtree retries. It clears
   * state only — it does not change a React key, so a child that throws on every
   * render re-enters the fallback immediately unless its props/`resetKeys`
   * change. */
  fallback: (args: { error: Error; reset: () => void }) => ReactNode;
  /** Clear the error and re-render `children` whenever any entry changes by
   * identity — pass the values that select what's rendered (repo path, active
   * tab, PR number, selected entity) so navigating away from a crashed view
   * recovers on its own. */
  resetKeys?: readonly unknown[];
  /** Side channel for logging/telemetry. Must not throw. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** The one place the app turns a render-time throw into a contained fallback
 * instead of a blank webview. Domain-free: it knows nothing about git/PRs, takes
 * a `fallback` renderer, and lives in `components/ui` so any vertical can wrap
 * its root in one. React still has no hook equivalent for
 * `getDerivedStateFromError`/`componentDidCatch`, so this is necessarily a class
 * (the same shape the upstream `react-error-boundary` would add as a dependency). */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    // Clear a caught error when the caller's reset keys change, so switching
    // repo/tab/PR/entity re-renders the subtree without an explicit retry click.
    if (this.state.error && !shallowEqual(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null });
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return this.props.fallback({ error: this.state.error, reset: this.reset });
    }
    return this.props.children;
  }
}

function shallowEqual(a?: readonly unknown[], b?: readonly unknown[]) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}
