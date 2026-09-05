//! Auth-only status probes for non-GitHub forge providers.
//!
//! These probes deliberately do not read, store, or return tokens. They only
//! report whether a local CLI/auth path appears usable so Settings can guide
//! users before real provider-specific PR integrations exist.

mod probe;
mod sign_out;
mod spec;
mod status;

pub use sign_out::sign_out;
pub use status::{account, statuses};

#[cfg(test)]
mod tests;
