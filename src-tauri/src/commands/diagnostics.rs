//! The frontend error log. The implementation — redaction, the size cap, and
//! the file write — lives in `crate::diagnostics`.

use tauri::{AppHandle, Manager};

use super::{blocking, CommandError};
use crate::diagnostics::{self, FrontendErrorReport};

/// Append one React render error to `frontend-errors.log` in the app-log
/// directory. The frontend drops a rejection, so a failed write is never shown.
#[tauri::command]
pub async fn report_frontend_error(
    app: AppHandle,
    report: FrontendErrorReport,
) -> Result<(), CommandError> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| CommandError::from(format!("failed to resolve app log dir: {e}")))?;
    blocking(move || {
        diagnostics::append_frontend_error(&log_dir, &report)
            .map_err(|e| format!("failed to write the frontend error log: {e}"))
    })
    .await
}
