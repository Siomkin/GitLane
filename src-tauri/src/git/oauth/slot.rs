//! The one-flow-at-a-time sign-in slot: claiming it, the pending window a
//! Cancel may land in, and the commit boundary a late Cancel can no longer
//! cross.

use std::sync::{Arc, Mutex};

use super::CancelFlag;

/// Shared state for the in-flight sign-in: a sticky `canceled` flag and an
/// `in_progress` guard that refuses a second concurrent flow (mirrors the GitHub
/// sign-in slot). The flag closes the race where a Cancel lands before the flow
/// registers: `starting` marks that window (armed by the command before it
/// schedules the worker, see [`arm_sign_in`]), so a Cancel with no flow pending
/// records nothing and cannot fail the *next* sign-in.
#[derive(Default)]
pub struct SignInSlotState {
    pub(super) starting: bool,
    pub(super) in_progress: bool,
    pub(super) canceled: bool,
    /// The final credential transaction has been linearized. Cancellation after
    /// this point is too late to abort and must not claim success while the
    /// keychain write is already committing.
    pub(super) committing: bool,
}

pub type SignInSlot = Arc<Mutex<SignInSlotState>>;

/// Bridges the slot's `canceled` flag to the flow state machines. A poisoned
/// lock reads as canceled (fail closed — stop the flow).
pub(super) struct SlotCancel(pub(super) SignInSlot);

impl CancelFlag for SlotCancel {
    fn is_canceled(&self) -> bool {
        self.0.lock().map(|g| g.canceled).unwrap_or(true)
    }
}

/// Clears `in_progress` (and any lingering cancel) when the flow returns, by any
/// path, so the slot is always clean for the next sign-in.
pub(super) struct InProgressGuard(pub(super) SignInSlot);

impl Drop for InProgressGuard {
    fn drop(&mut self) {
        if let Ok(mut g) = self.0.lock() {
            g.starting = false;
            g.in_progress = false;
            g.canceled = false;
            g.committing = false;
        }
    }
}

/// Take the in-progress slot for a new flow. Rejects a concurrent sign-in, and —
/// the fast-cancel path — honours a Cancel that reached the slot before the
/// worker did: consume it and refuse to start, so the flow never opens a browser
/// or stores a token after the user already canceled. On success `in_progress`
/// is set and the caller owns it via [`InProgressGuard`].
pub(super) fn claim_slot(slot: &SignInSlot) -> Result<(), String> {
    let mut g = slot.lock().map_err(|e| e.to_string())?;
    if g.in_progress {
        return Err("A provider sign-in is already in progress.".into());
    }
    g.starting = false;
    if g.canceled {
        // A Cancel raced ahead of us — consume it and don't start. The slot is
        // left clean (not in progress, no lingering cancel).
        g.canceled = false;
        return Err("Sign-in canceled.".into());
    }
    g.in_progress = true;
    g.committing = false;
    Ok(())
}

/// Atomically cross the cancellation boundary into the final keychain write.
/// Either Cancel acquired the slot first and this returns without storing, or
/// this marks the flow committed first and later cancellation is a no-op.
pub(super) fn begin_credential_commit(slot: &SignInSlot) -> Result<(), String> {
    let mut g = slot.lock().map_err(|e| e.to_string())?;
    if g.canceled {
        return Err("Sign-in canceled.".into());
    }
    g.committing = true;
    Ok(())
}

/// Open the pending window for a sign-in about to be scheduled. The command
/// calls this *before* it hands [`run_sign_in`](super::run_sign_in) to the blocking pool, so a
/// Cancel that lands before the worker claims the slot is still recorded.
pub fn arm_sign_in(slot: &SignInSlot) {
    if let Ok(mut g) = slot.lock() {
        g.starting = true;
    }
}

/// Signal the in-flight sign-in to stop. Instant (a lock + a flag), so the IPC
/// command stays synchronous and never queues behind the blocking pool. With no
/// flow pending (it already finished) nothing is recorded, so a late Cancel
/// cannot fail the next sign-in.
pub fn cancel_sign_in(slot: &SignInSlot) -> Result<(), String> {
    let mut g = slot
        .lock()
        .map_err(|_| "Could not access the provider sign-in state.".to_string())?;
    if g.committing {
        return Err("Sign-in has already completed and can no longer be canceled.".to_string());
    }
    if g.starting || g.in_progress {
        g.canceled = true;
    }
    Ok(())
}
