//! Integer conversions std has no `From` for.

/// `usize` as `u64`: lossless on every target Rust supports, but std has no
/// `From` because `usize` may one day be wider. Saturates if it ever is.
pub(crate) fn u64_from_usize(n: usize) -> u64 {
    u64::try_from(n).unwrap_or(u64::MAX)
}
