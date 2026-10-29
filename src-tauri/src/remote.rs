//! The desktop side of remote repositories (remote-ssh-repos): `ssh://`
//! locators, one `ssh` session per host running the agent, and the classified
//! errors a failed session turns into.
//!
//! Results here are command results on their way to IPC, so the same
//! `result_large_err` reasoning as `commands/` applies.
#![allow(clippy::result_large_err)]

pub mod connect;
pub mod forward;
pub mod locator;
pub mod registry;
pub mod session;
pub mod ssh_errors;
#[cfg(test)]
mod test_support;
