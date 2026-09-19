//! The cancel slot: claiming it, the fast-cancel path, and the commit boundary
//! that a late cancel can no longer cross.

use super::support::*;

#[test]
fn cancel_sets_the_flag() {
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState::default()));
    cancel_sign_in(&slot).unwrap();
    assert!(slot.lock().unwrap().canceled);
    assert!(SlotCancel(slot.clone()).is_canceled());
}

#[test]
fn guard_clears_in_progress_and_cancel() {
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState {
        in_progress: true,
        canceled: true,
        committing: false,
    }));
    {
        let _guard = InProgressGuard(slot.clone());
    }
    let g = slot.lock().unwrap();
    assert!(!g.in_progress);
    assert!(!g.canceled);
}

#[test]
fn claim_honours_a_cancel_that_raced_before_the_slot() {
    // The fast-cancel path: Cancel reaches the slot before the worker claims
    // it. The worker must NOT start (no browser opened, no token stored).
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState::default()));
    cancel_sign_in(&slot).unwrap();

    let err = claim_slot(&slot).unwrap_err();
    assert!(err.contains("canceled"), "{err}");
    let g = slot.lock().unwrap();
    assert!(!g.in_progress, "must not start after a pre-claim cancel");
    assert!(!g.canceled, "the cancel is consumed, not left sticky");
}

#[test]
fn claim_starts_when_not_canceled() {
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState::default()));
    assert!(claim_slot(&slot).is_ok());
    assert!(slot.lock().unwrap().in_progress);
}

#[test]
fn claim_refuses_a_concurrent_flow() {
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState {
        in_progress: true,
        canceled: false,
        committing: false,
    }));
    assert!(claim_slot(&slot)
        .unwrap_err()
        .contains("already in progress"));
}

#[test]
fn canceled_flow_cannot_begin_the_credential_commit() {
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState {
        in_progress: true,
        canceled: true,
        committing: false,
    }));

    assert!(begin_credential_commit(&slot)
        .unwrap_err()
        .contains("canceled"));
    assert!(!slot.lock().unwrap().committing);
}

#[test]
fn credential_commit_linearizes_before_a_late_cancel() {
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState {
        in_progress: true,
        canceled: false,
        committing: false,
    }));

    begin_credential_commit(&slot).unwrap();
    let error = cancel_sign_in(&slot).unwrap_err();

    let g = slot.lock().unwrap();
    assert!(error.contains("can no longer be canceled"));
    assert!(g.committing);
    assert!(!g.canceled, "cancel is too late once storage has committed");
}
