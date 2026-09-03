import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";
import { ErrorFallback } from "./ErrorFallback";
import { workingChangesSchema } from "@/lib/api/schemas";
import { IpcValidationError, parse } from "@/lib/api/validate";

// A child that throws on demand, so a test can drive the boundary into and out
// of its error state.
function Boom({ explode }: { explode: boolean }) {
  if (explode) throw new Error("kaboom");
  return <div>safe child</div>;
}

beforeEach(() => {
  // React logs every caught error to console.error; silence it so the suite
  // output stays readable (we assert on the rendered fallback, not the log).
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("ErrorBoundary", () => {
  it("renders children untouched when they don't throw", () => {
    render(
      <ErrorBoundary fallback={() => <div>fallback</div>}>
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("safe child")).toBeInTheDocument();
    expect(screen.queryByText("fallback")).not.toBeInTheDocument();
  });

  it("shows the fallback with the caught error and recovers via reset", () => {
    function Harness() {
      const [explode, setExplode] = useState(true);
      return (
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <button type="button"
              onClick={() => {
                setExplode(false);
                reset();
              }}
            >
              retry: {error.message}
            </button>
          )}
        >
          <Boom explode={explode} />
        </ErrorBoundary>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "retry: kaboom" }));
    expect(screen.getByText("safe child")).toBeInTheDocument();
  });

  it("forwards the error to onError", () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary fallback={() => <div>fallback</div>} onError={onError}>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.anything());
  });

  it("contains a malformed IPC payload that slips into a render (GL-56 meets GL-57)", () => {
    // A view that parses a command result while rendering — the one path where
    // seam validation and the boundary meet. The payload passes the `invoke`
    // type (it's a WorkingChanges-shaped object) but fails the schema, so
    // `parse` throws an IpcValidationError mid-render; the boundary swallows it
    // and renders the same fallback CenterWorkspace wires, message included.
    const malformed = { staged: "not-a-list", unstaged: [], conflicted: [] };
    function View() {
      const changes = parse(workingChangesSchema, malformed, "working_changes");
      return <div>{changes.staged.length} staged</div>;
    }
    const onError = vi.fn();
    render(
      <ErrorBoundary
        onError={onError}
        fallback={({ error, reset }) => (
          <ErrorFallback message={`Something went wrong in this view.\n${error.message}`} onRetry={reset} />
        )}
      >
        <View />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledWith(expect.any(IpcValidationError), expect.anything());
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong in this view.");
    expect(alert).toHaveTextContent('Malformed response from "working_changes"');
    expect(alert).toHaveTextContent("staged:");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("clears a caught error when resetKeys change", () => {
    function Harness({ keyVal, explode }: { keyVal: number; explode: boolean }) {
      return (
        <ErrorBoundary resetKeys={[keyVal]} fallback={() => <div>fallback</div>}>
          <Boom explode={explode} />
        </ErrorBoundary>
      );
    }
    const { rerender } = render(<Harness keyVal={1} explode />);
    expect(screen.getByText("fallback")).toBeInTheDocument();
    // A new reset key + a child that no longer throws re-mounts the subtree.
    rerender(<Harness keyVal={2} explode={false} />);
    expect(screen.getByText("safe child")).toBeInTheDocument();
  });
});
