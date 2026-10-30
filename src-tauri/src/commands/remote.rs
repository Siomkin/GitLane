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
        // Stopping a watch never connects: a host that is gone has no watch
        // left to stop, and closing its tab mustn't prompt or install.
        if command == "unwatch_repo" {
            let result = match sessions.live(&locator).await {
                Some(session) => session.request(&command, server_args).await,
                None => Ok(Value::Null),
            };
            sessions.closed(&locator).await;
            return result;
        }
        let session = session_for(&app, &sessions, &locator).await?;
        if command == "watch_repo" {
            sessions.opened(&locator).await;
        }
        session.request(&command, server_args).await
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
) -> Result<RemoteHost, CommandError> {
    let connected = async {
        let locator = Locator::parse(&locator).map_err(CommandError::internal)?;
        let session = session_for(&app, &sessions, &locator).await?;
        let hello = session.hello();
        Ok::<_, CommandError>(RemoteHost {
            origin: locator.origin(),
            home: hello.home.clone(),
            git: hello.git.clone(),
        })
    };
    boundary(connected.await)
}

/// Test a connection as the form has it (`identity_file` included), on a fresh
/// connection of its own that is closed straight after: a live session to the
/// same host is neither reused nor disturbed. Asks sign-in questions and
/// installs the agent like any connect.
#[tauri::command]
pub async fn test_ssh_connection<R: Runtime>(
    app: AppHandle<R>,
    locator: String,
    identity_file: Option<String>,
) -> Result<RemoteHost, CommandError> {
    let tested = blocking(move || {
        let locator = Locator::parse(&locator).map_err(CommandError::internal)?;
        let session = connect_to(&app, &locator, identity_file, false)?;
        let hello = session.hello().clone();
        session.close();
        Ok::<_, CommandError>(RemoteHost {
            origin: locator.origin(),
            home: hello.home,
            git: hello.git,
        })
    })
    .await;
    boundary(tested)
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

/// `ssh` questions still waiting on the user, oldest first: a webview that
/// reloaded while one was open shows it again.
#[tauri::command]
pub async fn list_ssh_prompts(
    prompts: State<'_, SshPrompts>,
) -> Result<Vec<SshPromptEvent>, CommandError> {
    boundary(Ok::<_, CommandError>(prompts.pending()))
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

pub(super) fn app_data<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, CommandError> {
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
/// A connect re-installs the watches of the repositories already open on the
/// host: they died with the previous agent.
async fn session_for<R: Runtime>(
    app: &AppHandle<R>,
    sessions: &RemoteSessions,
    locator: &Locator,
) -> Result<Arc<Session>, CommandError> {
    let app = app.clone();
    let locator_for_connect = locator.clone();
    let (session, lost) = sessions
        .session_and_lost_watches(locator, move || {
            let locator = locator_for_connect;
            let origin = locator.origin();
            emit_state(&app, &origin, RemoteSessionState::Connecting, None, None);
            let result = connect_to(&app, &locator, None, true);
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
        .await?;
    for repo in lost {
        let Ok(repo) = Locator::parse(&repo) else {
            continue;
        };
        let session = session.clone();
        tauri::async_runtime::spawn(async move {
            let _ = session
                .request("watch_repo", serde_json::json!({ "path": repo.path }))
                .await;
        });
    }
    Ok(session)
}

/// `identity_file` overrides the saved connection's key (the form's Test).
/// `announce` reports install progress and the session's end as
/// `remote-session-changed`; a test connection reports neither, so it never
/// changes what a live tab on the same host shows.
fn connect_to<R: Runtime>(
    app: &AppHandle<R>,
    locator: &Locator,
    identity_file: Option<String>,
    announce: bool,
) -> Result<Session, CommandError> {
    let origin = locator.origin();
    let data = app_data(app)?;
    let cache = data.join("remote-agents");
    let ssh_args =
        connections::key_args(&data, &origin, identity_file).map_err(CommandError::internal)?;
    let progress = {
        let app = app.clone();
        let origin = origin.clone();
        move |step: Step| {
            if !announce {
                return;
            }
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
            app.state::<SshPrompts>().ask(
                |id| SshPromptEvent {
                    id,
                    origin: origin.clone(),
                    prompt: prompt.to_string(),
                    kind,
                },
                |event| crate::events::emit(&app, crate::events::SSH_PROMPT, event.clone()),
            )
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
        Box::new(move || {
            if announce {
                emit_state(&app, &origin, RemoteSessionState::Disconnected, None, None);
            }
        })
    };
    connect::connect(locator, on_event, on_close).map(|(session, _)| session)
}
