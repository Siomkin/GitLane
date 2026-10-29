//! The headless agent that serves a remote repository over SSH
//! (remote-ssh-repos). Compiled into both builds: the desktop uses
//! [`dispatch`]'s command list to decide what may be forwarded, and the agent
//! binary uses it to run the command.
//!
//! Like `commands/`, this is the boundary where results become
//! [`CommandError`](crate::commands::CommandError), once per call, so the same
//! `result_large_err` reasoning applies.
#![allow(clippy::result_large_err)]

pub mod dispatch;
