use std::io::BufReader;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::{HelloError, OnEvent, Session};
use crate::agent::dispatch::Progress;
use crate::agent::protocol::Request;
use crate::commands::CommandError;
use crate::git::types::CommandErrorKind;

fn run<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(future)
}

/// The agent's real loop with a test handler on the other end of two pipes.
/// Returns the session and a flag set when it closes.
fn connect<H, F>(handler: H, on_event: OnEvent) -> (Session, Arc<AtomicBool>)
where
    H: Fn(Request, Progress) -> F + Send + 'static,
    F: std::future::Future<Output = Result<Value, CommandError>> + Send + 'static,
{
    let closed = Arc::new(AtomicBool::new(false));
    let flag = closed.clone();
    let (session, hello) = crate::remote::test_support::loopback(
        handler,
        on_event,
        Box::new(move || flag.store(true, Ordering::SeqCst)),
    );
    assert_eq!(hello.home.as_deref(), Some("/home/u"));
    assert!(hello.git_error.is_none());
    (session, closed)
}

fn ignore_events() -> OnEvent {
    Arc::new(|_, _| {})
}

#[test]
fn concurrent_requests_each_get_their_own_answer() {
    let (session, _) = connect(
        |req, _| async move {
            if req.cmd == "slow" {
                tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_millis(200)))
                    .await
                    .unwrap();
            }
            Ok(json!({ "cmd": req.cmd, "args": req.args }))
        },
        ignore_events(),
    );
    let session = Arc::new(session);
    let (slow, fast) = run(async {
        let a = session.clone();
        let slow = tokio::spawn(async move { a.request("slow", json!({ "n": 1 })).await });
        let b = session.clone();
        let fast = tokio::spawn(async move { b.request("fast", json!({ "n": 2 })).await });
        (slow.await.unwrap(), fast.await.unwrap())
    });
    assert_eq!(slow.unwrap(), json!({ "cmd": "slow", "args": { "n": 1 } }));
    assert_eq!(fast.unwrap(), json!({ "cmd": "fast", "args": { "n": 2 } }));
}

#[test]
fn agent_errors_arrive_as_command_errors() {
    let (session, _) = connect(
        |_, _| async move {
            Err(CommandError::new(
                CommandErrorKind::UnsupportedOnRemote,
                "not here",
            ))
        },
        ignore_events(),
    );
    let err = run(session.request("pty_spawn", json!({}))).unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::UnsupportedOnRemote);
}

#[test]
fn events_are_passed_on_with_their_name() {
    let seen: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let sink = seen.clone();
    let (session, _) = connect(
        |_, progress| async move {
            progress(crate::events::HANDOFF_PROGRESS, json!({ "step": "move" }));
            Ok(Value::Null)
        },
        Arc::new(move |name, payload| sink.lock().unwrap().push((name.to_string(), payload))),
    );
    run(session.request("move_branch_to_worktree", json!({}))).unwrap();
    // The event frame is written before the response, so it has been routed.
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        &[(
            crate::events::HANDOFF_PROGRESS.to_string(),
            json!({ "step": "move" })
        )]
    );
}

#[test]
fn closing_fails_what_is_waiting_and_later_requests() {
    let (session, closed) = connect(
        |_, _| async move {
            tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_secs(30)))
                .await
                .unwrap();
            Ok(Value::Null)
        },
        ignore_events(),
    );
    let session = Arc::new(session);
    let waiting = {
        let session = session.clone();
        std::thread::spawn(move || run(session.request("hangs", json!({}))))
    };
    std::thread::sleep(Duration::from_millis(100));
    session.close();
    let err = waiting.join().unwrap().unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::RemoteUnavailable);
    assert_eq!(err.code.as_deref(), Some("disconnected"));
    assert!(err.message.contains("devbox"), "{}", err.message);
    assert!(!session.is_alive());
    let later = run(session.request("next", json!({}))).unwrap_err();
    assert_eq!(later.kind, CommandErrorKind::RemoteUnavailable);
    let _ = closed;
}

#[test]
fn a_stream_that_ends_before_hello_is_a_closed_session() {
    let (desktop_reads, agent_writes) = std::io::pipe().unwrap();
    drop(agent_writes);
    let result = Session::start(
        "devbox",
        Box::new(BufReader::new(desktop_reads)),
        Box::new(std::io::sink()),
        ignore_events(),
        Box::new(|| {}),
    );
    assert!(matches!(result, Err(HelloError::Closed)));
}

fn start_on(bytes: Vec<u8>) -> Result<(Session, super::Hello), HelloError> {
    Session::start(
        "devbox",
        Box::new(BufReader::new(std::io::Cursor::new(bytes))),
        Box::new(std::io::sink()),
        ignore_events(),
        Box::new(|| {}),
    )
}

#[test]
fn shell_noise_before_the_hello_is_skipped() {
    let mut bytes = b"Welcome to Ubuntu!\nlast login: today\n".to_vec();
    bytes.extend(crate::agent::protocol::encode(
        &crate::agent::protocol::hello(None, None, None),
    ));
    let (_, hello) = start_on(bytes).unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(hello.protocol, crate::agent::protocol::PROTOCOL);
}

#[test]
fn output_that_never_becomes_the_agent_is_invalid_or_closed() {
    assert!(matches!(
        start_on(b"Welcome to Ubuntu!\n".to_vec()),
        Err(HelloError::Closed)
    ));
    let endless = "noise\n".repeat(200).into_bytes();
    assert!(matches!(start_on(endless), Err(HelloError::Invalid(_))));
}
