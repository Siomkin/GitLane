//! Test-only race injection points. Each hook deterministically mutates a
//! fixture inside the window a coherence check is supposed to close; the
//! `#[cfg(not(test))]` runners compile to nothing in release builds.

#[cfg(test)]
std::thread_local! {
    static READ_PREFIX_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static AFTER_GUARDED_RENAME_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

/// Deterministically mutate a fixture after the bounded descriptor read but
/// before its held-FD/path coherence checks.
#[cfg(test)]
pub(crate) fn set_read_prefix_test_hook(hook: impl FnOnce() + 'static) {
    READ_PREFIX_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(super) fn run_read_prefix_test_hook() {
    READ_PREFIX_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_read_prefix_test_hook() {}

/// Deterministically replace the just-published editor file before its
/// post-rename identity/content verification.
#[cfg(test)]
pub(crate) fn set_after_guarded_rename_test_hook(hook: impl FnOnce() + 'static) {
    AFTER_GUARDED_RENAME_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(super) fn run_after_guarded_rename_test_hook() {
    AFTER_GUARDED_RENAME_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_after_guarded_rename_test_hook() {}
