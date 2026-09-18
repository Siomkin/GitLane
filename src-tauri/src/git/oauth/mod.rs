//! Native provider OAuth sign-in for GitLab and Bitbucket (GL-139).
//!
//! Builds on the GL-132 provider-token foundation: an OAuth sign-in ends by
//! writing the resolved access token into the same GitLane-namespaced OS keychain
//! ([`crate::secrets`]) that the `GIT_ASKPASS` credential bridge later reads, so
//! the token authenticates git HTTPS transport without ever crossing IPC.
//!
//! The orchestration mirrors the interactive GitHub sign-in
//! (`git::forge::signin`): one flow at a time, a cancel handle parked in a
//! [`SignInSlot`], progress reported through a callback (the command layer
//! forwards it to the webview as `provider-oauth-progress`), and only non-secret
//! account metadata returned. Two flows dispatch by
//! provider — GitLab's device grant ([`device`]) and Bitbucket's PKCE loopback
//! ([`pkce`]) — both resolving identity ([`identity`]) before the token is stored.
//!
//! Secrets (access token, device code, PKCE verifier, authorization code) live
//! only inside this module; every surfaced error is passed through
//! [`crate::redact::redact_secrets`] as defence in depth.

pub mod client_ids;
pub mod config;
pub mod device;
pub mod http;
pub mod identity;
pub mod pkce;
pub mod types;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::secrets::{KeyringStore, SecretKey, SecretStore};

use self::config::OauthFlow;
use self::device::{Clock, RealClock};
use self::http::{HttpTransport, UreqTransport};
use self::types::{OauthClientStatus, ProviderOauthProgress, ProviderOauthResult};

/// How long the PKCE loopback waits for the browser redirect before timing out.
const PKCE_TIMEOUT_SECS: u64 = 600;

/// A cancellable predicate shared with the flow state machines so a Cancel from
/// another command can interrupt a poll loop or a loopback wait.
pub trait CancelFlag: Send + Sync {
    fn is_canceled(&self) -> bool;
}

/// Shared state for the in-flight sign-in: a sticky `canceled` flag and an
/// `in_progress` guard that refuses a second concurrent flow (mirrors the GitHub
/// sign-in slot). The flag closes the race where a Cancel lands before the flow
/// registers.
#[derive(Default)]
pub struct SignInSlotState {
    in_progress: bool,
    canceled: bool,
    /// The final credential transaction has been linearized. Cancellation after
    /// this point is too late to abort and must not claim success while the
    /// keychain write is already committing.
    committing: bool,
}

pub type SignInSlot = Arc<Mutex<SignInSlotState>>;

/// Bridges the slot's `canceled` flag to the flow state machines. A poisoned
/// lock reads as canceled (fail closed — stop the flow).
struct SlotCancel(SignInSlot);

impl CancelFlag for SlotCancel {
    fn is_canceled(&self) -> bool {
        self.0.lock().map(|g| g.canceled).unwrap_or(true)
    }
}

/// Clears `in_progress` (and any lingering cancel) when the flow returns, by any
/// path, so the slot is always clean for the next sign-in.
struct InProgressGuard(SignInSlot);

impl Drop for InProgressGuard {
    fn drop(&mut self) {
        if let Ok(mut g) = self.0.lock() {
            g.in_progress = false;
            g.canceled = false;
            g.committing = false;
        }
    }
}

/// What a sign-in runs against: where it reports progress and finds client-id
/// overrides, and the network, keychain and clock it uses. [`run_sign_in`] builds
/// the real ones; tests pass mocks, so the orchestration runs without Tauri, a
/// network, or the OS keychain.
struct SignInEnv<'a> {
    progress: &'a dyn Fn(&ProviderOauthProgress),
    /// The app-data dir holding per-host client-id overrides. `None` when the
    /// caller could not resolve it: the built-in client id still applies.
    client_ids_dir: Option<&'a Path>,
    http: &'a dyn HttpTransport,
    store: &'a dyn SecretStore,
    clock: &'a dyn Clock,
}

/// Run a native OAuth sign-in end-to-end (on the blocking pool). Reports each
/// step through `progress` and returns only non-secret account metadata; the
/// token is written straight to the keychain and never reaches `progress`.
pub fn run_sign_in(
    progress: &dyn Fn(&ProviderOauthProgress),
    client_ids_dir: Option<&Path>,
    slot: SignInSlot,
    provider: &str,
    host: &str,
) -> Result<ProviderOauthResult, String> {
    let http = UreqTransport::new();
    let store = KeyringStore::new();
    let env = SignInEnv {
        progress,
        client_ids_dir,
        http: &http,
        store: &store,
        clock: &RealClock,
    };
    run_sign_in_inner(&env, slot, provider, host).map_err(|e| crate::redact::redact_secrets(&e))
}

/// Take the in-progress slot for a new flow. Rejects a concurrent sign-in, and —
/// the fast-cancel path — honours a Cancel that reached the slot before the
/// worker did: consume it and refuse to start, so the flow never opens a browser
/// or stores a token after the user already canceled. On success `in_progress`
/// is set and the caller owns it via [`InProgressGuard`].
fn claim_slot(slot: &SignInSlot) -> Result<(), String> {
    let mut g = slot.lock().map_err(|e| e.to_string())?;
    if g.in_progress {
        return Err("A provider sign-in is already in progress.".into());
    }
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
fn begin_credential_commit(slot: &SignInSlot) -> Result<(), String> {
    let mut g = slot.lock().map_err(|e| e.to_string())?;
    if g.canceled {
        return Err("Sign-in canceled.".into());
    }
    g.committing = true;
    Ok(())
}

fn run_sign_in_inner(
    env: &SignInEnv<'_>,
    slot: SignInSlot,
    provider: &str,
    host: &str,
) -> Result<ProviderOauthResult, String> {
    let host = host.trim().to_ascii_lowercase();
    let host = host.as_str();

    let cfg = config::provider_config(provider)
        .ok_or_else(|| format!("Native OAuth isn't supported for '{provider}'."))?;
    let endpoints = config::endpoints(provider, host)
        .ok_or_else(|| format!("Native OAuth isn't available for {host}."))?;
    let (client_id, _source) =
        resolve_client_id(env.client_ids_dir, provider, host).ok_or_else(|| {
            "No OAuth client id is configured for this host. Use a personal access token, or set a \
         client id in Settings."
                .to_string()
        })?;

    // Claim the slot: refuse a concurrent flow, and honour a Cancel that raced
    // ahead of us registering (the fast-cancel path).
    claim_slot(&slot)?;
    let _guard = InProgressGuard(slot.clone());
    let cancel = SlotCancel(slot.clone());

    let token = match cfg.flow {
        OauthFlow::Device => {
            run_device(env, provider, &endpoints, &client_id, cfg.scopes, &cancel)?
        }
        OauthFlow::Pkce => run_pkce(env, provider, &endpoints, &client_id, cfg.scopes, &cancel)?,
    };
    if cancel.is_canceled() {
        return Err("Sign-in canceled.".into());
    }

    emit(env, provider, "authorized", None, None, None);
    let account = identity::resolve_account(env.http, provider, &endpoints.user_api, &token)?;

    // Namespaced so a native sign-in can never share a keychain slot with a
    // pasted token whose typed login equals this provider id.
    let account_id = identity::oauth_account_id(&account.account_id);
    let key = SecretKey::new(provider, host, &account_id);
    key.validate()?;
    begin_credential_commit(&slot)?;
    emit(env, provider, "storing", None, None, None);
    env.store.set(&key, &token)?;

    Ok(ProviderOauthResult {
        provider: provider.to_string(),
        host: host.to_string(),
        account_id,
        login: account.login,
        name: account.name,
        transport_username: cfg.transport_username.to_string(),
        has_token: true,
    })
}

fn run_device(
    env: &SignInEnv<'_>,
    provider: &str,
    endpoints: &config::Endpoints,
    client_id: &str,
    scopes: &str,
    cancel: &dyn CancelFlag,
) -> Result<String, String> {
    let device_endpoint = endpoints
        .device_authorization
        .as_deref()
        .ok_or_else(|| "This provider has no device flow.".to_string())?;
    if cancel.is_canceled() {
        return Err("Sign-in canceled.".into());
    }
    let code = device::request_device_code(env.http, device_endpoint, client_id, scopes)?;
    emit(
        env,
        provider,
        "device_code",
        Some(code.user_code.clone()),
        Some(code.open_uri().to_string()),
        Some(code.expires_in),
    );
    emit(env, provider, "polling", None, None, None);
    device::poll_for_token(
        env.http,
        &endpoints.token,
        client_id,
        &code,
        env.clock,
        cancel,
    )
}

fn run_pkce(
    env: &SignInEnv<'_>,
    provider: &str,
    endpoints: &config::Endpoints,
    client_id: &str,
    scopes: &str,
    cancel: &dyn CancelFlag,
) -> Result<String, String> {
    let authorize = endpoints
        .authorize
        .as_deref()
        .ok_or_else(|| "This provider has no authorize endpoint.".to_string())?;
    if cancel.is_canceled() {
        return Err("Sign-in canceled.".into());
    }
    let pkce = pkce::generate_pkce()?;
    let state = pkce::generate_state()?;
    // Bind the loopback before opening the browser so the redirect always lands.
    let listener = pkce::bind_loopback()?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not read the local sign-in port: {e}"))?
        .port();
    let redirect_uri = pkce::redirect_uri(port);
    let authorize_url = pkce::build_authorize_url(
        authorize,
        client_id,
        &redirect_uri,
        scopes,
        &state,
        &pkce.challenge,
    );
    emit(
        env,
        provider,
        "browser",
        None,
        Some(authorize_url),
        Some(PKCE_TIMEOUT_SECS),
    );
    emit(env, provider, "waiting", None, None, None);

    let deadline = Instant::now() + Duration::from_secs(PKCE_TIMEOUT_SECS);
    let redirect = pkce::wait_for_redirect(&listener, deadline, cancel, &state)?;
    // The listener already accepts only the callback carrying `state` (so an
    // unrelated local request cannot abort the sign-in); this re-check is
    // defence in depth and keeps the success/error handling below honest.
    if redirect.state.as_deref() != Some(state.as_str()) {
        return Err("Sign-in failed a security check (state mismatch). Please try again.".into());
    }
    if let Some(err) = redirect.error {
        let detail = redirect.error_description.unwrap_or(err);
        return Err(format!("Authorization failed: {detail}"));
    }
    let code = redirect
        .code
        .ok_or_else(|| "The provider did not return an authorization code.".to_string())?;
    pkce::exchange_code(
        env.http,
        &endpoints.token,
        client_id,
        &code,
        &redirect_uri,
        &pkce.verifier,
    )
}

/// Signal the in-flight sign-in to stop. Instant (a lock + a flag), so the IPC
/// command stays synchronous and never queues behind the blocking pool.
pub fn cancel_sign_in(slot: &SignInSlot) -> Result<(), String> {
    let mut g = slot
        .lock()
        .map_err(|_| "Could not access the provider sign-in state.".to_string())?;
    if g.committing {
        return Err("Sign-in has already completed and can no longer be canceled.".to_string());
    }
    g.canceled = true;
    Ok(())
}

/// Resolve the effective public client id for `provider`/`host`: a per-host
/// Settings override wins over the compile-time built-in.
fn resolve_client_id(
    client_ids_dir: Option<&Path>,
    provider: &str,
    host: &str,
) -> Option<(String, &'static str)> {
    if let Some(id) = client_ids_dir.and_then(|dir| client_ids::get(dir, provider, host)) {
        return Some((id, "override"));
    }
    config::builtin_client_id(provider).map(|id| (id.to_string(), "builtin"))
}

/// Non-secret OAuth-configuration status for the Settings UI. `client_ids_dir`
/// is `None` when the app-data dir cannot be resolved; the built-in id still counts.
pub fn client_status(
    client_ids_dir: Option<&Path>,
    provider: &str,
    host: &str,
) -> OauthClientStatus {
    let host = host.trim().to_ascii_lowercase();
    let supported = config::is_supported(provider);
    let (configured, source) = if supported {
        match resolve_client_id(client_ids_dir, provider, &host) {
            Some((_, src)) => (true, src),
            None => (false, "none"),
        }
    } else {
        (false, "none")
    };
    OauthClientStatus {
        provider: provider.to_string(),
        host,
        configured,
        source: source.to_string(),
        supported,
    }
}

/// Set (or clear, when empty) the per-host client-id override.
pub fn set_client_id(
    client_ids_dir: &Path,
    provider: &str,
    host: &str,
    client_id: &str,
) -> Result<(), String> {
    client_ids::set(client_ids_dir, provider, host, client_id)
}

fn emit(
    env: &SignInEnv<'_>,
    provider: &str,
    step: &str,
    user_code: Option<String>,
    verification_uri: Option<String>,
    expires_in_secs: Option<u64>,
) {
    (env.progress)(&ProviderOauthProgress {
        provider: provider.to_string(),
        step: step.to_string(),
        user_code,
        verification_uri,
        expires_in_secs,
    });
}

#[cfg(test)]
mod tests;
