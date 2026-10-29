//! One `ssh` session to a host, running the agent (remote-ssh-repos D5): send
//! request frames, match response frames to waiting requests by id, and pass
//! event frames on. Every repository tab on the host shares it.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::process::Child;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::ssh_errors;
use crate::agent::protocol;
use crate::git::types::CommandError;

/// Called for each event frame with its name and payload.
pub type OnEvent = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// What the agent said first.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub version: String,
    pub protocol: u32,
    pub git: Option<String>,
    pub git_error: Option<CommandError>,
    pub home: Option<String>,
}

/// Why no hello arrived.
#[derive(Debug)]
pub enum HelloError {
    /// The stream ended first: `ssh` failed (its stderr says why).
    Closed,
    /// Something answered, but not the agent's hello.
    Invalid(String),
}

type Reply = oneshot::Sender<Result<Value, CommandError>>;

struct Shared {
    host: String,
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<Pending>,
}

#[derive(Default)]
struct Pending {
    next_id: u64,
    waiting: HashMap<u64, Reply>,
    closed: bool,
}

pub struct Session {
    shared: Arc<Shared>,
    child: Mutex<Option<Child>>,
    hello: Hello,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
    /// Mark the session closed and fail everything still waiting.
    fn close(&self) {
        let waiting = {
            let mut pending = lock(&self.pending);
            pending.closed = true;
            std::mem::take(&mut pending.waiting)
        };
        for (_, reply) in waiting {
            let _ = reply.send(Err(ssh_errors::disconnected(&self.host)));
        }
    }
}

impl Session {
    /// Read the agent's hello from `reader`, then serve the stream on a
    /// background thread. `on_close` runs once when the stream ends. The
    /// transport's process, if any, is attached afterwards ([`Self::attach`]),
    /// so a failed start leaves it with the caller to reap and diagnose.
    pub fn start(
        host: &str,
        mut reader: Box<dyn BufRead + Send>,
        writer: Box<dyn Write + Send>,
        on_event: OnEvent,
        on_close: Box<dyn FnOnce() + Send>,
    ) -> Result<(Session, Hello), HelloError> {
        let hello = read_hello(&mut reader)?;
        let shared = Arc::new(Shared {
            host: host.to_string(),
            writer: Mutex::new(writer),
            pending: Mutex::default(),
        });
        let reading = shared.clone();
        thread::spawn(move || {
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => route(&reading, &on_event, &line),
                }
            }
            reading.close();
            on_close();
        });
        let session = Session {
            shared,
            child: Mutex::new(None),
            hello: hello.clone(),
        };
        Ok((session, hello))
    }

    /// Hand over the transport's process, stopped by [`Self::close`].
    pub fn attach(&self, child: Child) {
        *lock(&self.child) = Some(child);
    }

    /// What the agent said when the session started.
    pub fn hello(&self) -> &Hello {
        &self.hello
    }

    pub fn is_alive(&self) -> bool {
        !lock(&self.shared.pending).closed
    }

    /// Run `command` on the host and wait for its answer.
    pub async fn request(&self, command: &str, args: Value) -> Result<Value, CommandError> {
        let (reply, answer) = oneshot::channel();
        let id = {
            let mut pending = lock(&self.shared.pending);
            if pending.closed {
                return Err(ssh_errors::disconnected(&self.shared.host));
            }
            pending.next_id += 1;
            let id = pending.next_id;
            pending.waiting.insert(id, reply);
            id
        };
        let frame = protocol::encode(&json!({ "id": id, "cmd": command, "args": args }));
        let sent = {
            let mut writer = lock(&self.shared.writer);
            writer.write_all(&frame).and_then(|()| writer.flush())
        };
        if sent.is_err() {
            self.shared.close();
        }
        answer
            .await
            .unwrap_or_else(|_| Err(ssh_errors::disconnected(&self.shared.host)))
    }

    /// End the session: stop `ssh`, which ends the stream and fails anything
    /// still waiting.
    pub fn close(&self) {
        if let Some(mut child) = lock(&self.child).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.shared.close();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}

/// Lines a login shell may print before the agent starts (a banner, an `echo`
/// in `.bashrc`) are skipped, up to this many.
const NOISE_LINES: usize = 100;

fn read_hello(reader: &mut Box<dyn BufRead + Send>) -> Result<Hello, HelloError> {
    let mut line = Vec::new();
    for _ in 0..NOISE_LINES {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return Err(HelloError::Closed),
            Ok(_) => {}
        }
        let Some(hello) = protocol::decode(&line)
            .ok()
            .and_then(|frame| frame.get("hello").cloned())
        else {
            continue;
        };
        return serde_json::from_value(hello).map_err(|e| HelloError::Invalid(e.to_string()));
    }
    Err(HelloError::Invalid(
        "the remote shell printed output but never started the GitLane agent".into(),
    ))
}

/// Deliver one frame: a response to its waiting request, an event to `on_event`.
/// A frame the session cannot use is dropped; the agent only reports protocol
/// errors for lines this side sent malformed, which a request timeout surfaces.
fn route(shared: &Shared, on_event: &OnEvent, line: &[u8]) {
    let Ok(frame) = protocol::decode(line) else {
        return;
    };
    let Some(id) = frame.get("id").and_then(Value::as_u64) else {
        return;
    };
    if let Some(name) = frame.get("event").and_then(Value::as_str) {
        on_event(name, frame.get("payload").cloned().unwrap_or(Value::Null));
        return;
    }
    let result = match frame.get("err") {
        Some(err) => Err(serde_json::from_value(err.clone()).unwrap_or_else(|_| {
            CommandError::internal("The remote agent returned an unreadable error.")
        })),
        None => Ok(frame.get("ok").cloned().unwrap_or(Value::Null)),
    };
    if let Some(reply) = lock(&shared.pending).waiting.remove(&id) {
        let _ = reply.send(result);
    }
}

#[cfg(test)]
mod tests;
