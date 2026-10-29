use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::json;

use super::RemoteSessions;
use crate::remote::locator::Locator;
use crate::remote::test_support::echo_session;

fn run<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(future)
}

fn at(text: &str) -> Locator {
    Locator::parse(text).unwrap()
}

#[test]
fn repositories_on_one_host_share_one_connection() {
    let sessions = RemoteSessions::default();
    let connects = Arc::new(AtomicUsize::new(0));
    let connect = |n: Arc<AtomicUsize>| {
        move || {
            n.fetch_add(1, Ordering::SeqCst);
            Ok(echo_session())
        }
    };
    run(async {
        let a = sessions
            .session(&at("ssh://devbox/srv/a"), connect(connects.clone()))
            .await
            .unwrap();
        let b = sessions
            .session(&at("ssh://devbox/srv/b"), connect(connects.clone()))
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(
            b.request("open_repo", json!({})).await.unwrap(),
            "open_repo"
        );
        sessions
            .session(&at("ssh://other/srv/a"), connect(connects.clone()))
            .await
            .unwrap();
    });
    assert_eq!(connects.load(Ordering::SeqCst), 2, "one per host");
}

#[test]
fn closing_the_last_repository_ends_the_hosts_session() {
    let sessions = RemoteSessions::default();
    let (a, b) = (at("ssh://devbox/srv/a"), at("ssh://devbox/srv/b"));
    run(async {
        let session = sessions.session(&a, || Ok(echo_session())).await.unwrap();
        sessions.opened(&a).await;
        sessions.opened(&b).await;
        assert!(!sessions.closed(&a).await, "b is still open");
        assert!(session.is_alive());
        assert!(sessions.closed(&b).await, "that was the last one");
        assert!(!session.is_alive());
    });
}

#[test]
fn a_closed_session_is_replaced_on_the_next_request() {
    let sessions = RemoteSessions::default();
    let a = at("ssh://devbox/srv/a");
    run(async {
        let first = sessions.session(&a, || Ok(echo_session())).await.unwrap();
        first.close();
        let second = sessions.session(&a, || Ok(echo_session())).await.unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(second.is_alive());
    });
}

#[test]
fn a_failed_connect_is_returned_and_not_kept() {
    let sessions = RemoteSessions::default();
    let a = at("ssh://devbox/srv/a");
    run(async {
        let err = sessions
            .session(&a, || {
                Err(crate::remote::ssh_errors::classify(
                    "devbox",
                    "Host key verification failed.",
                ))
            })
            .await
            .err()
            .unwrap();
        assert_eq!(err.code.as_deref(), Some("sshHostKey"));
        assert!(sessions.session(&a, || Ok(echo_session())).await.is_ok());
    });
}
