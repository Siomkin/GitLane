## 1. Origin Provider Operations

- [x] 1.1 Add Origin create-PR argument construction and execution using the existing `run_origin` boundary, including repository, head, base, title, body, and explicit open/draft status; cover both statuses with focused Rust tests.
- [x] 1.2 Add close, reopen, and ready argument construction and execution, reject unknown lifecycle actions instead of defaulting to a mutation, and cover every mapping with focused Rust tests.
- [x] 1.3 Wire `OriginProvider::create_pr` and `OriginProvider::set_pr_state` to the new operations while leaving review, edit, and new-comment writes unsupported and preserving Origin-specific redacted errors.

## 2. Frontend Availability and Feedback

- [x] 2.1 Add Cursor Origin to the existing create-PR provider gate and update its pure capability tests so the current dialog and store flow become available without a new frontend path.
- [x] 2.2 Decouple Origin lifecycle visibility from its basic merge restrictions, expose Close/Reopen/Ready through the existing controls, and test that Origin still omits rebase and delete-branch while GitLab and Bitbucket remain unchanged.
- [x] 2.3 Extend the shared external-URL helper with minimal asynchronous opener-error reporting, make the PR external-link action report missing, invalid, and rejected URLs, and add focused success/failure click tests.

## 3. Verification

- [x] 3.1 Run the focused Origin Rust tests and the frontend tests for forge capability gates, PR actions, and the external opener.
- [x] 3.2 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, and `bun run sizes`.
- [x] 3.3 Run `cargo check`, `cargo fmt --all -- --check`, and `cargo clippy --all-targets --all-features -- -D warnings` from `src-tauri`.
- [x] 3.4 In `bun run tauri dev`, use a user-approved disposable Origin repository to verify opening an Origin PR externally and the create/open-draft/close/reopen/ready flows, confirming list/detail refreshes and actionable failures without exposing credentials.
