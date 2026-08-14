//! The byte ceilings the capture applies, and the notice a truncated failure
//! message carries.

pub(in crate::git::forge) const DEFAULT_STDOUT_LIMIT: usize = 4 * 1024 * 1024;
pub(in crate::git::forge) const DIFF_STDOUT_LIMIT: usize = 32 * 1024 * 1024;
pub(in crate::git::forge) const STDERR_LIMIT: usize = 1024 * 1024;

/// How much excess stderr is discarded before the stream is treated as a
/// runaway rather than a verbose one. Generous enough that no real CLI trace
/// reaches it, low enough that a child which never stops writing is still
/// killed instead of draining forever.
pub(super) const STDERR_DRAIN_CEILING: usize = 64 * 1024 * 1024;

pub(super) const READ_CHUNK: usize = 16 * 1024;
pub(super) const INITIAL_CAPACITY: usize = 64 * 1024;

/// Appended to a failure message whose diagnostics were cut short, so a partial
/// tail is never mistaken for the CLI's complete output.
pub(in crate::git::forge) fn stderr_truncated_notice() -> String {
    format!("\n… diagnostic output truncated at {STDERR_LIMIT} bytes.")
}
