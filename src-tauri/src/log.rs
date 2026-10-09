//! Process-local diagnostics.
//!
//! Debug builds write to stderr. Release builds compile the macros out so a PR
//! list (or any other command) never prints to the user's terminal. This is not
//! a persistent logging crate — file output is a separate product decision.

macro_rules! debug {
    // `cfg!` rather than `#[cfg]`: release still type-checks the arguments (so
    // they don't trip `unused_variables`), then drops the dead branch.
    ($($arg:tt)*) => {{
        if cfg!(debug_assertions) {
            eprintln!($($arg)*);
        }
    }};
}

macro_rules! warning {
    // `cfg!` rather than `#[cfg]`: release still type-checks the arguments (so
    // they don't trip `unused_variables`), then drops the dead branch.
    ($($arg:tt)*) => {{
        if cfg!(debug_assertions) {
            eprintln!($($arg)*);
        }
    }};
}

pub(crate) use debug;
pub(crate) use warning as warn;
