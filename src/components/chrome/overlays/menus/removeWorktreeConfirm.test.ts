// GL-296: the removal confirm's wording and its force decision. Pure — the
// menus' own tests cover the probe/await wiring.
import { describe, it, expect } from "vitest";
import {
  buildRemoveWorktreeConfirm,
  describeIgnoredEntries,
  describeUncommittedWork,
  hasUncommittedWork,
  type RemoveWorktreeSubject,
} from "./removeWorktreeConfirm";

const subject = (over: Partial<RemoveWorktreeSubject> = {}): RemoveWorktreeSubject => ({
  name: "repo-feat",
  path: "/work/repo-feat",
  branch: "feat",
  head: null,
  locked: false,
  dirty: { modified: 0, untracked: 0, ignored: 0 },
  ...over,
});

describe("hasUncommittedWork", () => {
  it("is false for a clean probe, a null probe, and true once anything is dirty", () => {
    expect(hasUncommittedWork(null)).toBe(false);
    expect(hasUncommittedWork({ modified: 0, untracked: 0, ignored: 0 })).toBe(false);
    expect(hasUncommittedWork({ modified: 1, untracked: 0, ignored: 0 })).toBe(true);
    expect(hasUncommittedWork({ modified: 0, untracked: 1, ignored: 0 })).toBe(true);
  });
});

describe("describeUncommittedWork", () => {
  it("joins both halves, drops a zero half, and singularises", () => {
    expect(describeUncommittedWork({ modified: 29, untracked: 3, ignored: 0 })).toBe(
      "29 modified files and 3 untracked files",
    );
    expect(describeUncommittedWork({ modified: 29, untracked: 0, ignored: 0 })).toBe("29 modified files");
    expect(describeUncommittedWork({ modified: 0, untracked: 2, ignored: 0 })).toBe("2 untracked files");
    expect(describeUncommittedWork({ modified: 1, untracked: 1, ignored: 0 })).toBe(
      "1 modified file and 1 untracked file",
    );
  });
});

describe("buildRemoveWorktreeConfirm", () => {
  it("leaves a clean unlocked removal unforced and unwarned", () => {
    const confirm = buildRemoveWorktreeConfirm(subject());
    expect(confirm.force).toBe(false);
    expect(confirm.warnings).toHaveLength(0);
    expect(confirm.confirmLabel).toBe("Remove worktree");
    expect(confirm.details.join(" ")).toContain("/work/repo-feat");
  });

  it("names the branch that survives the removal", () => {
    expect(buildRemoveWorktreeConfirm(subject()).details.join(" ")).toContain(
      "Its branch feat and that branch's commits are kept",
    );
  });

  it("warns about a stranded commit instead of promising the commits are kept", () => {
    const confirm = buildRemoveWorktreeConfirm(
      subject({ branch: null, head: "abc1234def567890000000000000000000000fff" }),
    );
    expect(confirm.warnings.join(" ")).toContain("abc1234");
    expect(confirm.warnings.join(" ")).toContain("may become unreachable");
    expect(confirm.details.join(" ")).not.toContain("kept");
  });

  it("forces and warns when the worktree holds uncommitted work", () => {
    const confirm = buildRemoveWorktreeConfirm(subject({ dirty: { modified: 29, untracked: 3, ignored: 0 } }));
    expect(confirm.force).toBe(true);
    expect(confirm.confirmLabel).toBe("Remove and discard changes");
    expect(confirm.warnings.join(" ")).toContain("29 modified files and 3 untracked files");
    // The irreversibility is the point — uncommitted work has no reflog.
    expect(confirm.warnings.join(" ")).toContain("cannot be recovered");
  });

  it("forces a locked worktree even when it is clean", () => {
    const confirm = buildRemoveWorktreeConfirm(subject({ locked: true }));
    expect(confirm.force).toBe(true);
    expect(confirm.warnings.join(" ")).toContain("override the lock");
    // Clean, so the button keeps the plain label.
    expect(confirm.confirmLabel).toBe("Remove worktree");
  });

  it("warns about both the lock and the uncommitted work when it is dirty and locked", () => {
    const confirm = buildRemoveWorktreeConfirm(
      subject({ locked: true, dirty: { modified: 2, untracked: 0, ignored: 0 } }),
    );
    expect(confirm.force).toBe(true);
    expect(confirm.warnings.join(" ")).toContain("override the lock");
    expect(confirm.warnings.join(" ")).toContain("2 modified files");
  });

  // A failed probe must degrade to the ordinary unforced confirm, never block
  // the removal or silently claim the worktree is clean.
  it("treats an unavailable probe as an ordinary unforced removal", () => {
    const confirm = buildRemoveWorktreeConfirm(subject({ dirty: null }));
    expect(confirm.force).toBe(false);
    expect(confirm.confirmLabel).toBe("Remove worktree");
  });

  // Review finding (high): a lock forces the removal on its own, which also
  // overrides git's dirty check. With the probe unavailable we cannot say the
  // worktree is clean, so the loss must be disclosed rather than the dialog
  // mentioning only the lock. `git worktree lock` is *for* volumes that go
  // away, which is exactly when the probe fails — this is not a corner case.
  it("discloses possible data loss when a locked worktree's probe failed", () => {
    const confirm = buildRemoveWorktreeConfirm(subject({ locked: true, dirty: null }));
    expect(confirm.force).toBe(true);
    const warnings = confirm.warnings.join(" ");
    expect(warnings).toContain("could not check this worktree for uncommitted changes");
    expect(warnings).toContain("permanently delete");
    // Must not read as a routine removal when work may be destroyed.
    expect(confirm.confirmLabel).toBe("Remove and discard changes");
  });

  it("does not cry data loss for an unlocked failed probe, which stays unforced", () => {
    const confirm = buildRemoveWorktreeConfirm(subject({ locked: false, dirty: null }));
    expect(confirm.force).toBe(false);
    expect(confirm.warnings.join(" ")).not.toContain("could not check");
  });
});

// Review finding (P1): ignored files are invisible to `--untracked-files=all`,
// yet git deletes them on an UNFORCED remove. They must not make the worktree
// "dirty" (that would make every node_modules worktree unremovable) but they
// must be disclosed — a local .env is ignored too.
describe("ignored entries", () => {
  it("does not count as uncommitted work, so no force is demanded", () => {
    const dirty = { modified: 0, untracked: 0, ignored: 4 };
    expect(hasUncommittedWork(dirty)).toBe(false);
    const confirm = buildRemoveWorktreeConfirm(subject({ dirty }));
    expect(confirm.force).toBe(false);
    expect(confirm.confirmLabel).toBe("Remove worktree");
  });

  it("is still disclosed in the warnings so nothing vanishes unmentioned", () => {
    const confirm = buildRemoveWorktreeConfirm(subject({ dirty: { modified: 0, untracked: 0, ignored: 4 } }));
    const warnings = confirm.warnings.join(" ");
    expect(warnings).toContain("4 ignored entries");
    expect(warnings).toContain(".env");
  });

  it("singularises and stays silent when there are none", () => {
    expect(describeIgnoredEntries({ modified: 0, untracked: 0, ignored: 1 })).toContain("1 ignored entry");
    expect(describeIgnoredEntries({ modified: 0, untracked: 0, ignored: 0 })).toBeNull();
    expect(describeIgnoredEntries(null)).toBeNull();
  });
});
