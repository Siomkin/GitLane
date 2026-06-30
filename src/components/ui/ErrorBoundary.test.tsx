import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

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
            <button
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
