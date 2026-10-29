//! The agent's main loop: read request lines, run each concurrently, write
//! frames as they complete. Only protocol frames go to the output; anything
//! the agent itself reports goes to stderr, redacted.

use std::future::Future;
use std::io::{BufRead, Write};
use std::sync::{mpsc, Arc};
use std::thread;

use serde_json::Value;

use super::dispatch::{dispatch, Progress};
use super::protocol::{self, Request};
use crate::commands::CommandError;

/// Run the agent on this process's stdin/stdout until stdin closes (the `ssh`
/// session ended), then finish the requests in flight.
pub fn serve_stdio() {
    serve(
        std::io::BufReader::new(std::io::stdin()),
        std::io::stdout(),
        hello(),
        |request, progress| async move { dispatch(&request.cmd, &request.args, progress).await },
    );
}

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
    // interleave within a line.
    let (frames, outbox) = mpsc::channel::<Vec<u8>>();
    let writer = thread::spawn(move || {
        for frame in outbox {
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
                    let _ = frames.send(protocol::encode(&protocol::protocol_error(&format!(
                        "not a request: {e}"
                    ))));
                    continue;
                }
            };
            let id = request.id;
            let events = frames.clone();
            let progress: Progress = Arc::new(move |name, payload| {
                let _ = events.send(protocol::encode(&protocol::event(id, name, payload)));
            });
            let work = handler(request, progress);
            let replies = frames.clone();
            in_flight.spawn(async move {
                let frame = protocol::response(id, work.await);
                let _ = replies.send(protocol::encode(&frame));
            });
        }
        while in_flight.join_next().await.is_some() {}
    });
    drop(frames);
    let _ = writer.join();
}

#[cfg(test)]
mod tests;
