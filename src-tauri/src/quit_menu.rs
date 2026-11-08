//! The macOS app menu's Quit item. Not the predefined one: that terminates
//! without a window close request, so the unsaved-draft prompt would never run.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{MenuItem, MenuItemBuilder};
use tauri::{App, AppHandle, Listener, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Emitted by the frontend's close handler (`acknowledgeCloseRequest`).
const CLOSE_REQUEST_SEEN: &str = "close-request-seen";
/// Long enough that a merely busy webview isn't called hung: forcing quit loses a draft.
const RESPONSE_WAIT: Duration = Duration::from_secs(5);

static AWAITING_RESPONSE: AtomicBool = AtomicBool::new(false);

/// Build the item and route it through the main window's close path.
pub fn build_item(app: &App) -> tauri::Result<MenuItem<Wry>> {
    let quit = MenuItemBuilder::with_id("quit", "Quit GitLane")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    app.on_menu_event(|app, event| {
        if event.id() != "quit" {
            return;
        }
        let Some(window) = app.get_webview_window("main") else {
            return app.exit(0);
        };
        // A prompt on a minimized window would look like Quit did nothing.
        let _ = window.unminimize();
        offer_force_quit_if_unanswered(app);
        if window.close().is_err() {
            app.exit(0);
        }
    });
    Ok(quit)
}

/// The close request is answered in the webview, so a hung one would make Quit
/// do nothing. Off the main thread, so the wait can't freeze the menu.
fn offer_force_quit_if_unanswered(app: &AppHandle) {
    if AWAITING_RESPONSE.swap(true, Ordering::SeqCst) {
        return;
    }
    let seen = Arc::new(AtomicBool::new(false));
    let seen_by_listener = Arc::clone(&seen);
    let listener = app.once(CLOSE_REQUEST_SEEN, move |_| {
        seen_by_listener.store(true, Ordering::SeqCst);
    });
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(RESPONSE_WAIT);
        AWAITING_RESPONSE.store(false, Ordering::SeqCst);
        if seen.load(Ordering::SeqCst) {
            return;
        }
        app.unlisten(listener);
        let quitting = app.clone();
        app.dialog()
            .message("GitLane isn't responding. Force quit? Unsaved edits will be lost.")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Force Quit".into(),
                "Keep Waiting".into(),
            ))
            .show(move |force| {
                if force {
                    quitting.exit(0);
                }
            });
    });
}
