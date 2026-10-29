//! A session wired to the agent's real serve loop over in-process pipes, so
//! the desktop half is tested against the agent half without `ssh`.

use std::io::BufReader;

use serde_json::Value;

use super::session::{Hello, OnEvent, Session};
use crate::agent::protocol::{self, Request};
use crate::agent::run::Progress;
use crate::agent::serve::serve;
use crate::commands::CommandError;

pub fn loopback<H, F>(
    handler: H,
    on_event: OnEvent,
    on_close: Box<dyn FnOnce() + Send>,
) -> (Session, Hello)
where
    H: Fn(Request, Progress) -> F + Send + 'static,
    F: std::future::Future<Output = Result<Value, CommandError>> + Send + 'static,
{
    let (desktop_reads, agent_writes) = std::io::pipe().unwrap();
    let (agent_reads, desktop_writes) = std::io::pipe().unwrap();
    std::thread::spawn(move || {
        serve(
            BufReader::new(agent_reads),
            agent_writes,
            protocol::hello(
                Some("git version 2.53.0".into()),
                None,
                Some("/home/u".into()),
            ),
            handler,
        )
    });
    Session::start(
        "devbox",
        Box::new(BufReader::new(desktop_reads)),
        Box::new(desktop_writes),
        on_event,
        on_close,
    )
    .unwrap_or_else(|e| panic!("{e:?}"))
}

/// A session whose agent answers every request with its command name.
pub fn echo_session() -> Session {
    loopback(
        |req, _| async move { Ok(Value::String(req.cmd)) },
        std::sync::Arc::new(|_, _| {}),
        Box::new(|| {}),
    )
    .0
}
