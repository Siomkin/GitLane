//! Process-local diagnostics.
//!
//! Debug builds write to stderr. Release builds compile the macros out so a PR
//! list (or any other command) never prints to the user's terminal. This is not
//! a persistent logging crate — file output is a separate product decision.

macro_rules! debug {
    ($($arg:tt)*) => {{
        #[cfg(debug_assertions)]
        {
            eprintln!($($arg)*);
        }
    }};
}

macro_rules! warning {
    ($($arg:tt)*) => {{
        #[cfg(debug_assertions)]
        {
            eprintln!($($arg)*);
        }
    }};
}

pub(crate) use debug;
pub(crate) use warning as warn;
