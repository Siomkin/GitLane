//! Test hooks that open each window the lease has to survive: after the
//! capture, after the fingerprint pass, after validation, and immediately
//! before the mutation. Compiled out of release builds.

#[cfg(test)]
std::thread_local! {
    static HARD_RESET_CAPTURE_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    /// Fires after tip/HEAD preparation and immediately before the final lease
    /// re-capture that sits next to `git reset --hard` (GL-302 review).
    static HARD_RESET_BEFORE_MUTATION_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    /// Fires in the window the lease cannot close: after validation succeeded,
    /// before the `git reset --hard` process is launched (GL-302 review).
    static HARD_RESET_AFTER_VALIDATION_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    /// Fires inside a capture, after every leaf has been fingerprinted but
    /// before the observation sweep — the intra-capture window an edit to an
    /// already-hashed file would otherwise slip through (GL-302 review).
    static HARD_RESET_AFTER_FINGERPRINT_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
pub(crate) fn set_hard_reset_capture_test_hook(hook: impl FnOnce() + 'static) {
    HARD_RESET_CAPTURE_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_hard_reset_before_mutation_test_hook(hook: impl FnOnce() + 'static) {
    HARD_RESET_BEFORE_MUTATION_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_hard_reset_after_validation_test_hook(hook: impl FnOnce() + 'static) {
    HARD_RESET_AFTER_VALIDATION_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_hard_reset_after_fingerprint_test_hook(hook: impl FnOnce() + 'static) {
    HARD_RESET_AFTER_FINGERPRINT_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(super) fn run_after_fingerprint_test_hook() {
    HARD_RESET_AFTER_FINGERPRINT_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_after_fingerprint_test_hook() {}

#[cfg(test)]
pub(super) fn run_capture_test_hook() {
    HARD_RESET_CAPTURE_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_capture_test_hook() {}

#[cfg(test)]
pub(in crate::git::write) fn run_before_mutation_test_hook() {
    HARD_RESET_BEFORE_MUTATION_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(in crate::git::write) fn run_before_mutation_test_hook() {}

#[cfg(test)]
pub(in crate::git::write) fn run_after_validation_test_hook() {
    HARD_RESET_AFTER_VALIDATION_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(in crate::git::write) fn run_after_validation_test_hook() {}
