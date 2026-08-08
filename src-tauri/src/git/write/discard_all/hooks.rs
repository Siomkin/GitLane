//! Test hooks for the discard-all lease.
//!
//! Every entry point is `#[cfg(test)]` with a `#[cfg(not(test))]` no-op twin, so
//! the production build compiles the empty bodies away. They live here rather
//! than at the top of the operation so the lease logic reads without ~145 lines
//! of scaffolding in front of it. The setters stay `pub(crate)`: the write suite
//! drives them through the facade's re-export.

#[cfg(test)]
std::thread_local! {
    static DISCARD_ALL_CAPTURE_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static DISCARD_ALL_AFTER_VALIDATION_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static DISCARD_ALL_AFTER_CLEANUP_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static DISCARD_ALL_AFTER_FIRST_CLEAN_BATCH_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static DISCARD_ALL_BEFORE_TRACKED_RESET_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static DISCARD_ALL_AFTER_TRACKED_SCOPE_VALIDATION_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    pub(super) static DISCARD_ALL_FINGERPRINT_BYTES_TEST: std::cell::Cell<Option<u64>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_discard_all_capture_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_ALL_CAPTURE_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_discard_all_after_validation_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_ALL_AFTER_VALIDATION_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_discard_all_after_cleanup_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_ALL_AFTER_CLEANUP_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_discard_all_after_first_clean_batch_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_ALL_AFTER_FIRST_CLEAN_BATCH_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_discard_all_before_tracked_reset_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_ALL_BEFORE_TRACKED_RESET_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_discard_all_after_tracked_scope_validation_test_hook(
    hook: impl FnOnce() + 'static,
) {
    DISCARD_ALL_AFTER_TRACKED_SCOPE_VALIDATION_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn start_discard_all_fingerprint_byte_count() {
    DISCARD_ALL_FINGERPRINT_BYTES_TEST.with(|count| count.set(Some(0)));
}

#[cfg(test)]
pub(crate) fn take_discard_all_fingerprint_byte_count() -> u64 {
    DISCARD_ALL_FINGERPRINT_BYTES_TEST.with(|count| {
        count
            .take()
            .expect("discard-all fingerprint byte counting was not started")
    })
}

#[cfg(test)]
pub(super) fn run_capture_test_hook() {
    DISCARD_ALL_CAPTURE_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_capture_test_hook() {}

#[cfg(test)]
pub(super) fn run_after_validation_test_hook() {
    DISCARD_ALL_AFTER_VALIDATION_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_after_validation_test_hook() {}

#[cfg(test)]
pub(super) fn run_after_cleanup_test_hook() {
    DISCARD_ALL_AFTER_CLEANUP_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_after_cleanup_test_hook() {}

#[cfg(test)]
pub(super) fn run_after_first_clean_batch_test_hook() {
    DISCARD_ALL_AFTER_FIRST_CLEAN_BATCH_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_after_first_clean_batch_test_hook() {}

#[cfg(test)]
pub(super) fn run_before_tracked_reset_test_hook() {
    DISCARD_ALL_BEFORE_TRACKED_RESET_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_before_tracked_reset_test_hook() {}

#[cfg(test)]
pub(super) fn run_after_tracked_scope_validation_test_hook() {
    DISCARD_ALL_AFTER_TRACKED_SCOPE_VALIDATION_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_after_tracked_scope_validation_test_hook() {}
