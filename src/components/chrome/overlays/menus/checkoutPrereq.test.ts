import { describe, it, expect, vi } from "vitest";
import { confirmCheckoutPrereq } from "./checkoutPrereq";

const base = {
  branch: "feature",
  operation: "rebase feature onto main",
  confirmLabel: "Check out and rebase",
};

describe("confirmCheckoutPrereq", () => {
  it("runs directly with no popup when the branch is already checked out", () => {
    const requestConfirm = vi.fn();
    const proceed = vi.fn();
    confirmCheckoutPrereq({ ...base, headBranch: "feature", requestConfirm, proceed });
    expect(proceed).toHaveBeenCalledOnce();
    expect(requestConfirm).not.toHaveBeenCalled();
  });

  it("asks for approval naming the branch, prerequisite, and operation before a branch switch", () => {
    const requestConfirm = vi.fn();
    const proceed = vi.fn();
    confirmCheckoutPrereq({ ...base, headBranch: "main", requestConfirm, proceed });
    expect(proceed).not.toHaveBeenCalled();
    expect(requestConfirm).toHaveBeenCalledOnce();
    const req = requestConfirm.mock.calls[0][0];
    expect(req.title).toBe("Check out feature?");
    expect(req.message).toBe(
      'To rebase feature onto main, GitLane must check out branch "feature". Do you want to continue?',
    );
    expect(req.confirmLabel).toBe("Check out and rebase");

    // The combined flow runs only when the user approves.
    req.onConfirm();
    expect(proceed).toHaveBeenCalledOnce();
  });

  it("treats a detached HEAD (null headBranch) as a prerequisite needing approval", () => {
    const requestConfirm = vi.fn();
    const proceed = vi.fn();
    confirmCheckoutPrereq({ ...base, headBranch: null, requestConfirm, proceed });
    expect(proceed).not.toHaveBeenCalled();
    expect(requestConfirm).toHaveBeenCalledOnce();
  });
});
