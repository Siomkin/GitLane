//! Interactive `gh auth login --web` device-flow sign-in (GL-106).
//!
//! Every other `gh` call is one-shot request/response through
//! [`cli::run_gh`](super::cli) — but the web device flow is *interactive*: `gh`
//! prints a one-time code, waits for the user to authorize it in a browser, then
//! completes. `gh` needs a TTY for that flow, so we drive it inside a
//! pseudo-terminal (the same [`portable_pty`] stack the integrated terminal
//! uses), stream the parsed milestones to the webview as `github-signin-progress`
//! events, and park the child in a [`SignInSlot`] so [`cancel_sign_in`] can kill
//! it from another command. Tokens never cross IPC — only the device code, the
//! verification URL, and status steps do; `gh` writes the token to the system
//! credential store itself.

mod flow;
mod parse;
mod probes;
mod pty;
mod slot;
#[cfg(test)]
#[cfg(test)]
mod tests;

pub use flow::{cancel_sign_in, sign_in_web};
pub use slot::SignInSlot;
