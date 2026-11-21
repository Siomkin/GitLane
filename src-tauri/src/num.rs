//! Integer conversions std has no `From` for.

/// `usize` as `u64`: lossless on every target Rust supports, but std has no
/// `From` because `usize` may one day be wider. Saturates if it ever is.
pub(crate) fn u64_from_usize(n: usize) -> u64 {
    u64::try_from(n).unwrap_or(u64::MAX)
}

/// `u64` as `usize`, saturating at `usize::MAX` on targets where `usize` is
/// narrower (a cap or size there is then "everything").
pub(crate) fn usize_from_u64(n: u64) -> usize {
    usize::try_from(n).unwrap_or(usize::MAX)
}
