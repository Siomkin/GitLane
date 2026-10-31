//! The agent's main loop: read request lines, run each concurrently, write
//! frames as they complete. Only protocol frames go to the output; anything
//! the agent itself reports goes to stderr, redacted.

use std::future::Future;
use std::io::{BufRead, Write};
use std::sync::{mpsc, Arc};
use std::thread;

use serde_json::Value;

use super::protocol::{self, Request};
use super::run::Progress;
use crate::commands::CommandError;

/// Run the agent on this process's stdin/stdout until stdin closes (the `ssh`
/// session ended), then finish the requests in flight.
#[cfg(feature = "agent")]
pub fn serve_stdio() {
    serve(
        std::io::BufReader::new(std::io::stdin()),
        std::io::stdout(),
        hello(),
        |request, progress| async move {
            super::run::dispatch(&request.cmd, &request.args, progress).await
        },
    );
}

#[cfg(feature = "agent")]
fn hello() -> Value {
    let gate = crate::git::write::cli::ensure_supported_git().map_err(CommandError::from);
    let version = crate::git::isolated_git_command()
        .arg("--version")
        .env("PATH", crate::shell::path())
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());
    protocol::hello(version, gate.err(), std::env::var("HOME").ok())
}

/// The loop, generic over its streams and request handler so tests can drive
/// it without a process or a repository.
pub fn serve<R, W, H, F>(input: R, mut output: W, hello: Value, handler: H)
where
    R: BufRead + Send + 'static,
    W: Write + Send + 'static,
    H: Fn(Request, Progress) -> F,
    F: Future<Output = Result<Value, CommandError>> + Send + 'static,
{
    // One writer thread owns the output, so concurrent responses never
    // interleave within a line. An empty frame (never a real one: every frame
    // ends in a newline) stops it: watches keep senders alive for good, so
    // waiting for every sender to drop would keep the agent running after the
    // session ends.
    let (frames, outbox) = mpsc::channel::<Vec<u8>>();
    let writer = thread::spawn(move || {
        for frame in outbox {
            if frame.is_empty() {
                break;
            }
            if output
                .write_all(&frame)
                .and_then(|()| output.flush())
                .is_err()
            {
                break; // the desktop is gone; nothing left to tell it
            }
        }
    });
    let _ = frames.send(protocol::encode(&hello));

    // stdin is blocking, so a plain thread feeds lines to the runtime.
    let (lines_in, mut lines) = tokio::sync::mpsc::unbounded_channel::<String>();
    thread::spawn(move || {
        for line in input.lines() {
            let Ok(line) = line else { break };
            if lines_in.send(line).is_err() {
                break;
            }
        }
    });

    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("agent runtime");
    runtime.block_on(async {
        let mut in_flight = tokio::task::JoinSet::new();
        while let Some(line) = lines.recv().await {
            if line.trim().is_empty() {
                continue;
            }
            // Requests may be compressed too (a large conflict resolution).
            let request = protocol::decode(line.as_bytes()).and_then(|frame| {
                serde_json::from_value::<Request>(frame).map_err(|e| e.to_string())
            });
            let request = match request {
                Ok(request) => request,
                Err(e) => {
                    // Answer the request's own id when it has one, so the
                    // desktop's caller fails instead of waiting forever.
                    let why = format!("not a request: {e}");
                    let frame = match protocol::request_id(line.as_bytes()) {
                        Some(id) => protocol::response(id, Err(CommandError::internal(why))),
                        None => protocol::protocol_error(&why),
                    };
                    let _ = frames.send(protocol::encode(&frame));
                    continue;
                }
            };
            let id = request.id;
            let events = frames.clone();
            let progress: Progress = Arc::new(move |name, payload| {
                let _ = events.send(protocol::encode(&protocol::event(id, name, payload)));
            });
            // Its own task, so a panic becomes an error reply, not silence.
            let work = tokio::spawn(handler(request, progress));
            let replies = frames.clone();
            in_flight.spawn(async move {
                let result = work.await.unwrap_or_else(|e| {
                    Err(CommandError::internal(format!("The agent failed: {e}")))
                });
                let _ = replies.send(protocol::encode(&protocol::response(id, result)));
            });
        }
        while in_flight.join_next().await.is_some() {}
    });
    let _ = frames.send(Vec::new());
    let _ = writer.join();
}

#[cfg(test)]
mod tests;
