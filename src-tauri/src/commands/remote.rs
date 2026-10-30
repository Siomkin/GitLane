//! Repositories on another machine over SSH (remote-ssh-repos). Every
//! remote-capable command reaches its host through [`remote_invoke`]: the
//! frontend's `invoke()` routes any call whose path argument is an `ssh://`
//! locator here, so the 100+ commands themselves need no remote branch.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State};

use super::{blocking, boundary, CommandError};
use crate::agent::dispatch::is_remote_capable;
use crate::git::types::{
    CommandErrorKind, RemoteHost, RemoteProgress, RemoteProgressStage, RemoteSessionEvent,
    RemoteSessionState, SshConnection, SshPromptEvent,
};
use crate::remote::askpass::{self, SshPrompts};
use crate::remote::install::{self, Step};
use crate::remote::locator::Locator;
use crate::remote::registry::RemoteSessions;
use crate::remote::session::Session;
use crate::remote::{connect, connections, forward, ssh_config};

/// Run `command` for the repository its `ssh://` path argument names, on that
/// repository's host. Anything not remote-capable is refused before any
/// connection is made.
#[tauri::command]
pub async fn remote_invoke<R: Runtime>(
    app: AppHandle<R>,
    sessions: State<'_, RemoteSessions>,
    command: String,
    args: Value,
) -> Result<Value, CommandError> {
    let forwarded = async {
        if !is_remote_capable(&command) {
            return Err(CommandError::new(
                CommandErrorKind::UnsupportedOnRemote,
                format!("`{command}` is not available for remote repositories."),
            ));
        }
        let locator = forward::locator_of(&args)
            .ok_or_else(|| {
                CommandError::internal(format!("`{command}` has no ssh:// path argument."))
            })?
            .map_err(CommandError::internal)?;
        let server_args =
            forward::to_server_args(&args, &locator).map_err(CommandError::internal)?;
        let session = session_for(&app, &sessions, &locator, None).await?;
        if command == "watch_repo" {
            sessions.opened(&locator).await;
        }
        let result = session.request(&command, server_args).await;
        if command == "unwatch_repo" {
            sessions.closed(&locator).await;
        }
        result
    };
    boundary(forwarded.await)
}

/// Connect to `locator`'s host now (installing the agent if needed), so the
/// open dialog can show progress and errors before a tab exists.
#[tauri::command]
pub async fn remote_connect<R: Runtime>(
    app: AppHandle<R>,
    sessions: State<'_, RemoteSessions>,
    locator: String,
    identity_file: Option<String>,
) -> Result<RemoteHost, CommandError> {
    let connected = async {
        let locator = Locator::parse(&locator).map_err(CommandError::internal)?;
        let session = session_for(&app, &sessions, &locator, identity_file).await?;
        let hello = session.hello();
        Ok::<_, CommandError>(RemoteHost {
            origin: locator.origin(),
            home: hello.home.clone(),
            git: hello.git.clone(),
        })
    };
    boundary(connected.await)
}

/// End the session to `locator`'s host (reconnect, or the user's own request).
#[tauri::command]
pub async fn remote_disconnect(
    sessions: State<'_, RemoteSessions>,
    locator: String,
) -> Result<(), CommandError> {
    let locator = boundary(Locator::parse(&locator).map_err(CommandError::internal))?;
    sessions.disconnect(&locator).await;
    Ok(())
}

/// Answer `ssh`'s question `id` (an `ssh-prompt` event). `secret_answer` is
/// the password, passphrase or code — or `yes` to trust a host key — and
/// `None` cancels. It goes only to the waiting askpass helper of the `ssh`
/// that asked; it is never stored, logged or returned.
#[tauri::command]
pub async fn answer_ssh_prompt(
    prompts: State<'_, SshPrompts>,
    id: u64,
    secret_answer: Option<String>,
) -> Result<(), CommandError> {
    prompts.answer(id, secret_answer);
    boundary(Ok::<_, CommandError>(()))
}

/// The saved SSH connections, sorted by name.
#[tauri::command]
pub async fn list_ssh_connections<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<SshConnection>, CommandError> {
    let dir = boundary(app_data(&app))?;
    blocking(move || Ok::<_, CommandError>(connections::load(&dir))).await
}

/// Save `connection`, replacing the one for `previous_origin` when editing.
/// Returns the saved list.
#[tauri::command]
pub async fn save_ssh_connection<R: Runtime>(
    app: AppHandle<R>,
    previous_origin: Option<String>,
    connection: SshConnection,
) -> Result<Vec<SshConnection>, CommandError> {
    let dir = boundary(app_data(&app))?;
    blocking(move || connections::save(&dir, previous_origin.as_deref(), &connection)).await
}

/// Remove the saved connection for `origin`. Returns the saved list.
#[tauri::command]
pub async fn delete_ssh_connection<R: Runtime>(
    app: AppHandle<R>,
    origin: String,
) -> Result<Vec<SshConnection>, CommandError> {
    let dir = boundary(app_data(&app))?;
    blocking(move || connections::delete(&dir, &origin)).await
}

fn app_data<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map_err(|e| CommandError::internal(format!("No app data directory: {e}")))
}

/// Hosts from `~/.ssh/config` to suggest in the open dialog.
#[tauri::command]
pub async fn list_ssh_hosts() -> Result<Vec<String>, CommandError> {
    blocking(|| Ok::<_, CommandError>(ssh_config::user_hosts())).await
}

fn emit_state<R: Runtime>(
    app: &AppHandle<R>,
    origin: &str,
    state: RemoteSessionState,
    progress: Option<RemoteProgress>,
    error: Option<CommandError>,
) {
    crate::events::emit(
        app,
        crate::events::REMOTE_SESSION_CHANGED,
        RemoteSessionEvent {
            origin: origin.to_string(),
            state,
            progress,
            error,
        },
    );
}

/// The host's live session, connecting (and installing the agent) when there
/// is none. Each state change is announced as `remote-session-changed`.
/// `identity_file` overrides the saved connection's key (the form's Test).
async fn session_for<R: Runtime>(
    app: &AppHandle<R>,
    sessions: &RemoteSessions,
    locator: &Locator,
    identity_file: Option<String>,
) -> Result<Arc<Session>, CommandError> {
    let app = app.clone();
    let locator_for_connect = locator.clone();
    sessions
        .session(locator, move || {
            let locator = locator_for_connect;
            let origin = locator.origin();
            emit_state(&app, &origin, RemoteSessionState::Connecting, None, None);
            let result = connect_to(&app, &locator, identity_file);
            match &result {
                Ok(_) => emit_state(&app, &origin, RemoteSessionState::Connected, None, None),
                Err(e) => emit_state(
                    &app,
                    &origin,
                    RemoteSessionState::Failed,
                    None,
                    Some(e.clone()),
                ),
            }
            result
        })
        .await
}

fn connect_to<R: Runtime>(
    app: &AppHandle<R>,
    locator: &Locator,
    identity_file: Option<String>,
) -> Result<Session, CommandError> {
    let origin = locator.origin();
    let data = app_data(app)?;
    let cache = data.join("remote-agents");
    // The form's key while testing, else the saved connection's; used alone,
    // or agent keys could exhaust the server's attempts before it is tried.
    let key = identity_file
        .filter(|p| !p.trim().is_empty())
        .or_else(|| connections::for_origin(&data, &origin).and_then(|c| c.identity_file));
    let ssh_args = match key {
        Some(path) => {
            let path = connections::identity_path(&path).map_err(CommandError::internal)?;
            vec!["-i".into(), path, "-o".into(), "IdentitiesOnly=yes".into()]
        }
        None => Vec::new(),
    };
    let progress = {
        let app = app.clone();
        let origin = origin.clone();
        move |step: Step| {
            let (stage, percent) = match step {
                Step::Downloading(p) => (RemoteProgressStage::Downloading, p),
                Step::Uploading(p) => (RemoteProgressStage::Uploading, p),
            };
            let progress = RemoteProgress { stage, percent };
            emit_state(
                &app,
                &origin,
                RemoteSessionState::Installing,
                Some(progress),
                None,
            );
        }
    };
    // Questions `ssh` asks during this attempt (probe, upload, session) come
    // to the user as `ssh-prompt`; the lease ends with the attempt.
    let ask: askpass::Ask = {
        let app = app.clone();
        let origin = origin.clone();
        Arc::new(move |prompt: &str, kind| {
            app.state::<SshPrompts>().ask(|id| {
                let event = SshPromptEvent {
                    id,
                    origin: origin.clone(),
                    prompt: prompt.to_string(),
                    kind,
                };
                crate::events::emit(&app, crate::events::SSH_PROMPT, event);
            })
        })
    };
    let _askpass = askpass::start(&origin, ask, ssh_args).map_err(CommandError::internal)?;
    install::ensure_installed(locator, &cache, &progress)?;

    let on_event = {
        let app = app.clone();
        let locator = locator.clone();
        Arc::new(move |name: &str, payload: Value| {
            if let Some((name, payload)) = forward::to_webview_event(name, payload, &locator) {
                crate::events::emit(&app, name, payload);
            }
        })
    };
    let on_close = {
        let app = app.clone();
        Box::new(move || emit_state(&app, &origin, RemoteSessionState::Disconnected, None, None))
    };
    connect::connect(locator, on_event, on_close).map(|(session, _)| session)
}
