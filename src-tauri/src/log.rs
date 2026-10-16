//! Process-local diagnostics.
//!
//! Debug builds write to stderr. Release builds compile the macros out so a PR
//! list (or any other command) never prints to the user's terminal. This is not
//! a persistent logging crate. The only file log is the frontend render-error
//! log in `crate::diagnostics`.

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
