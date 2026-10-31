//! One session per host, shared by every repository tab on it
//! (`remote/ssh-repos`: one connection per host; closing the last repository
//! ends it).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use super::locator::Locator;
use super::session::Session;
use crate::commands::{blocking, CommandError};

#[derive(Default)]
struct Host {
    session: Option<Arc<Session>>,
    /// Repositories open on this host (their tabs watch them).
    repos: HashSet<String>,
}

/// Tauri-managed: the live sessions, keyed by host origin.
#[derive(Clone, Default)]
pub struct RemoteSessions(Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<Host>>>>>);

impl RemoteSessions {
    fn host(&self, origin: &str) -> Arc<tokio::sync::Mutex<Host>> {
        let mut hosts = self.0.lock().unwrap_or_else(|p| p.into_inner());
        hosts.entry(origin.to_string()).or_default().clone()
    }

    /// The live session for `locator`'s host. Connects with `connect` when
    /// there is none or it has closed; callers for the same host wait for that
    /// one connect instead of starting their own.
    #[cfg(test)]
    pub async fn session<C>(
        &self,
        locator: &Locator,
        connect: C,
    ) -> Result<Arc<Session>, CommandError>
    where
        C: FnOnce() -> Result<Session, CommandError> + Send + 'static,
    {
        self.session_and_lost_watches(locator, connect)
            .await
            .map(|(session, _)| session)
    }

    /// [`Self::session`], plus — when this call had to connect — the
    /// repositories open on the host, whose watches died with the previous
    /// agent and must be installed again on this one.
    pub async fn session_and_lost_watches<C>(
        &self,
        locator: &Locator,
        connect: C,
    ) -> Result<(Arc<Session>, Vec<String>), CommandError>
    where
        C: FnOnce() -> Result<Session, CommandError> + Send + 'static,
    {
        let host = self.host(&locator.origin());
        let mut host = host.lock().await;
        if let Some(session) = host.session.as_ref().filter(|s| s.is_alive()) {
            return Ok((session.clone(), Vec::new()));
        }
        let session = Arc::new(blocking(connect).await?);
        host.session = Some(session.clone());
        Ok((session, host.repos.iter().cloned().collect()))
    }

    /// The live session for `locator`'s host, without connecting.
    pub async fn live(&self, locator: &Locator) -> Option<Arc<Session>> {
        let host = self.host(&locator.origin());
        let host = host.lock().await;
        host.session.as_ref().filter(|s| s.is_alive()).cloned()
    }

    /// Note that `locator`'s repository is open in a tab.
    pub async fn opened(&self, locator: &Locator) {
        let host = self.host(&locator.origin());
        host.lock().await.repos.insert(locator.to_string());
    }

    /// Note that `locator`'s repository closed. Returns whether that was the
    /// host's last one, in which case its session has been ended.
    pub async fn closed(&self, locator: &Locator) -> bool {
        let host = self.host(&locator.origin());
        let mut host = host.lock().await;
        host.repos.remove(&locator.to_string());
        if !host.repos.is_empty() {
            return false;
        }
        if let Some(session) = host.session.take() {
            close_off_thread(session).await;
        }
        true
    }

    /// End `locator`'s host session now, whatever is open on it.
    pub async fn disconnect(&self, locator: &Locator) {
        let host = self.host(&locator.origin());
        let mut host = host.lock().await;
        host.repos.clear();
        if let Some(session) = host.session.take() {
            close_off_thread(session).await;
        }
    }
}

/// Stop `ssh` and reap it on the blocking pool, not an async worker.
async fn close_off_thread(session: Arc<Session>) {
    let _ = blocking(move || {
        session.close();
        Ok::<_, CommandError>(())
    })
    .await;
}

#[cfg(test)]
mod tests;
