//! The test hook that opens the window between capture and mutation.

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[cfg(test)]
std::thread_local! {
    static DISCARD_CAPTURE_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

/// Deterministically mutate a fixture after the expensive content pass but
/// before the fresh semantic/leaf checks. Thread-local state prevents parallel
/// tests for unrelated repositories from consuming the hook.
#[cfg(test)]
pub(crate) fn set_discard_capture_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_CAPTURE_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(super) fn run_discard_capture_test_hook() {
    DISCARD_CAPTURE_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_discard_capture_test_hook() {}
