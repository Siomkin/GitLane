//! The transient `127.0.0.1` listener: binding it, waiting for the OAuth
//! redirect, parsing the callback request, and answering the browser.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use super::super::CancelFlag;
use super::percent::percent_decode;

/// Keep the loopback parser bounded while allowing ordinary provider codes and
/// state values to arrive across several TCP reads. HTTP request lines are
/// normally far smaller; the cap prevents a local client from growing memory
/// without ever terminating the line.
const MAX_REQUEST_LINE_BYTES: usize = 8 * 1024;
/// Bound any one local client independently of the overall OAuth flow. A real
/// browser redirect queued behind a stalled probe must still get a chance.
const CALLBACK_CONNECTION_TIMEOUT: Duration = Duration::from_secs(2);
/// Blocking reads wake frequently enough to observe cancellation and absolute
/// deadlines instead of letting a drip-fed byte reset a per-read timeout.
const CALLBACK_READ_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// The parsed loopback redirect query.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Redirect {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// Bind a loopback listener on an ephemeral port. Returned so the orchestrator
/// can read the port for the redirect URI before opening the browser.
pub fn bind_loopback() -> Result<TcpListener, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Could not start the local sign-in listener: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Could not configure the local sign-in listener: {e}"))?;
    Ok(listener)
}

/// Wait for the OAuth redirect on the loopback listener, until it arrives, the
/// user cancels, or `deadline` passes. Answers the browser with a small "you can
/// close this window" page. The listener drops when this returns, discarding any
/// in-flight code.
pub fn wait_for_redirect(
    listener: &TcpListener,
    deadline: Instant,
    cancel: &dyn CancelFlag,
) -> Result<Redirect, String> {
    wait_for_redirect_with_connection_timeout(
        listener,
        deadline,
        CALLBACK_CONNECTION_TIMEOUT,
        cancel,
    )
}

fn wait_for_redirect_with_connection_timeout(
    listener: &TcpListener,
    deadline: Instant,
    connection_timeout: Duration,
    cancel: &dyn CancelFlag,
) -> Result<Redirect, String> {
    loop {
        if cancel.is_canceled() {
            return Err("Sign-in canceled.".into());
        }
        if Instant::now() >= deadline {
            return Err("The sign-in timed out. Please try again.".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                // A nonblocking listener can yield a nonblocking accepted
                // socket on BSD-derived platforms. Clear that inherited mode
                // before the bounded read: otherwise a fragmented callback's
                // second read sees `WouldBlock` and discards the one-time code.
                stream.set_nonblocking(false).map_err(|error| {
                    format!("Could not configure the local sign-in connection: {error}")
                })?;
                stream
                    .set_read_timeout(Some(CALLBACK_READ_POLL_INTERVAL))
                    .map_err(|error| {
                        format!("Could not bound the local sign-in connection: {error}")
                    })?;
                let connection_deadline = Instant::now()
                    .checked_add(connection_timeout)
                    .map_or(deadline, |connection_deadline| {
                        connection_deadline.min(deadline)
                    });
                let Some(request_line) =
                    read_request_line(&mut stream, connection_deadline, deadline, cancel)?
                else {
                    // EOF, malformed/oversized input, or the per-connection
                    // deadline: drop this client and accept the real callback.
                    continue;
                };
                let target = parse_callback_target(&request_line);
                let redirect = target
                    .as_deref()
                    .map(parse_redirect_query)
                    .unwrap_or_default();
                let terminal = redirect.code.is_some() || redirect.error.is_some();
                write_browser_response(&mut stream, terminal && redirect.error.is_none());
                // Ignore stray probes (favicon, etc.) that carry neither a code
                // nor an error; keep waiting for the real redirect.
                if terminal {
                    return Ok(redirect);
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Local sign-in listener failed: {e}")),
        }
    }
}

// ---- internals ----

/// Read one complete HTTP request line. TCP read boundaries are arbitrary, so
/// the browser may split even a short OAuth callback across packets; returning
/// after the first `read` can lose the one-time code permanently. Stop at the
/// first LF, EOF/error, cancellation, either absolute deadline, or the hard
/// line cap.
fn read_request_line(
    reader: &mut impl Read,
    connection_deadline: Instant,
    flow_deadline: Instant,
    cancel: &dyn CancelFlag,
) -> Result<Option<String>, String> {
    let mut line = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];

    loop {
        if cancel.is_canceled() {
            return Err("Sign-in canceled.".into());
        }
        let now = Instant::now();
        if now >= flow_deadline {
            return Err("The sign-in timed out. Please try again.".into());
        }
        if now >= connection_deadline {
            return Ok(None);
        }

        let Some(remaining) = MAX_REQUEST_LINE_BYTES.checked_sub(line.len()) else {
            return Ok(None);
        };
        if remaining == 0 {
            return Ok(None);
        }
        let chunk_len = remaining.min(chunk.len());
        let read = match reader.read(&mut chunk[..chunk_len]) {
            Ok(0) => return Ok(None),
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue;
            }
            Err(_) => return Ok(None),
        };
        if let Some(end) = chunk[..read].iter().position(|byte| *byte == b'\n') {
            line.extend_from_slice(&chunk[..=end]);
            let Ok(line) = std::str::from_utf8(&line) else {
                return Ok(None);
            };
            return Ok(Some(line.trim_end_matches(['\r', '\n']).to_string()));
        }
        line.extend_from_slice(&chunk[..read]);
    }
}

/// Extract the request target (`/callback?...`) from an HTTP request line
/// (`GET /callback?code=… HTTP/1.1`).
fn parse_callback_target(request_line: &str) -> Option<String> {
    let mut parts = request_line.split_ascii_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    if !parts.next()?.starts_with("HTTP/") || parts.next().is_some() {
        return None;
    }
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    (path == "/callback").then(|| target.to_string())
}

/// Parse the query of a loopback redirect target into its OAuth fields.
fn parse_redirect_query(target: &str) -> Redirect {
    let mut out = Redirect::default();
    let Some((_, query)) = target.split_once('?') else {
        return out;
    };
    for pair in query.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some((k, v)) => (k, percent_decode(v)),
            None => (pair, String::new()),
        };
        match key {
            "code" => out.code = Some(value),
            "state" => out.state = Some(value),
            "error" => out.error = Some(value),
            "error_description" => out.error_description = Some(value),
            _ => {}
        }
    }
    out
}

fn write_browser_response(stream: &mut impl Write, ok: bool) {
    let title = if ok { "Signed in" } else { "Sign-in failed" };
    let message = if ok {
        "You're signed in. You can close this tab and return to GitLane."
    } else {
        "Sign-in didn't complete. You can close this tab and try again in GitLane."
    };
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>{title}</title><body style=\"font-family:system-ui;padding:3rem;text-align:center\"><h2>{title}</h2><p>{message}</p></body>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
    use std::thread;

    struct NeverCancel;

    impl CancelFlag for NeverCancel {
        fn is_canceled(&self) -> bool {
            false
        }
    }

    struct SharedCancel(Arc<AtomicBool>);

    impl CancelFlag for SharedCancel {
        fn is_canceled(&self) -> bool {
            self.0.load(Ordering::Acquire)
        }
    }

    fn spawn_drip_feed(mut stream: TcpStream, stop: Arc<AtomicBool>) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                if stream.write_all(b"x").is_err() {
                    break;
                }
                let _ = stream.flush();
                thread::sleep(Duration::from_millis(40));
            }
        })
    }

    fn spawn_test_waiter(
        listener: TcpListener,
        deadline: Instant,
        connection_timeout: Duration,
        canceled: Arc<AtomicBool>,
    ) -> (
        mpsc::Receiver<Result<Redirect, String>>,
        thread::JoinHandle<()>,
    ) {
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let cancel = SharedCancel(canceled);
            let result = wait_for_redirect_with_connection_timeout(
                &listener,
                deadline,
                connection_timeout,
                &cancel,
            );
            let _ = sender.send(result);
        });
        (receiver, server)
    }

    fn finish_test_waiter(
        receiver: mpsc::Receiver<Result<Redirect, String>>,
        server: thread::JoinHandle<()>,
        timeout: Duration,
        context: &str,
        cleanup: impl FnOnce(),
    ) -> Result<Redirect, String> {
        let received = receiver.recv_timeout(timeout);
        cleanup();
        match received {
            Ok(result) => {
                server.join().expect("callback waiter");
                result
            }
            Err(timeout) => {
                if receiver.recv_timeout(Duration::from_secs(1)).is_ok() {
                    server.join().expect("callback waiter after cleanup");
                } else {
                    drop(server);
                }
                panic!("{context}: {timeout}");
            }
        }
    }

    #[test]
    fn parses_the_callback_target_from_a_request_line() {
        assert_eq!(
            parse_callback_target("GET /callback?code=abc&state=xyz HTTP/1.1").as_deref(),
            Some("/callback?code=abc&state=xyz")
        );
        assert_eq!(parse_callback_target("garbage"), None);
        assert_eq!(
            parse_callback_target("GET /favicon.ico?error=denied HTTP/1.1"),
            None
        );
        assert_eq!(
            parse_callback_target("POST /callback?code=abc HTTP/1.1"),
            None
        );
    }

    #[test]
    fn fragmented_callback_request_keeps_the_full_code_and_state() {
        let listener = bind_loopback().expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).expect("connect callback");
            stream
                .write_all(b"GET /callback?code=one-time&sta")
                .expect("write first fragment");
            stream.flush().expect("flush first fragment");
            thread::sleep(Duration::from_millis(100));
            let _ = stream.write_all(b"te=csrf-state HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        });

        let redirect = wait_for_redirect(
            &listener,
            Instant::now() + Duration::from_secs(2),
            &NeverCancel,
        )
        .expect("fragmented redirect");
        client.join().expect("callback client");

        assert_eq!(redirect.code.as_deref(), Some("one-time"));
        assert_eq!(redirect.state.as_deref(), Some("csrf-state"));
    }

    #[test]
    fn stalled_callback_read_observes_cancellation_promptly() {
        let listener = bind_loopback().expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        // Queue the connection before waiting so cancellation happens while
        // the server is inside its bounded request-line read.
        let mut stalled = TcpStream::connect(address).expect("connect stalled callback");
        stalled
            .write_all(b"GET /callback?code=never-finishes")
            .expect("write partial callback");
        stalled.flush().expect("flush partial callback");

        let canceled = Arc::new(AtomicBool::new(false));
        let (receiver, server) = spawn_test_waiter(
            listener,
            Instant::now() + Duration::from_secs(5),
            CALLBACK_CONNECTION_TIMEOUT,
            Arc::clone(&canceled),
        );
        thread::sleep(Duration::from_millis(250));
        let started = Instant::now();
        canceled.store(true, Ordering::Release);
        let result = finish_test_waiter(
            receiver,
            server,
            Duration::from_secs(1),
            "cancellation wait was unbounded",
            move || {
                let _ = stalled.shutdown(Shutdown::Both);
            },
        );
        let elapsed = started.elapsed();
        let error = result.expect_err("stalled callback must not defer cancellation");

        assert_eq!(error, "Sign-in canceled.");
        assert!(
            elapsed < Duration::from_secs(1),
            "cancellation took {elapsed:?}"
        );
    }

    #[test]
    fn slow_connection_is_dropped_for_the_real_callback() {
        let listener = bind_loopback().expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let mut slow = TcpStream::connect(address).expect("connect slow callback");
        slow.write_all(b"G").expect("write first drip byte");
        slow.flush().expect("flush first drip byte");
        let stop = Arc::new(AtomicBool::new(false));
        let slow_control = slow.try_clone().expect("clone slow callback");
        let drip = spawn_drip_feed(slow, Arc::clone(&stop));
        let real = thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            let mut stream = TcpStream::connect(address).expect("connect real callback");
            stream
                .write_all(
                    b"GET /callback?code=real-code&state=real-state HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
                )
                .expect("write real callback");
        });

        let (receiver, server) = spawn_test_waiter(
            listener,
            Instant::now() + Duration::from_secs(2),
            Duration::from_millis(200),
            Arc::new(AtomicBool::new(false)),
        );
        let result = finish_test_waiter(
            receiver,
            server,
            Duration::from_millis(1500),
            "real callback remained blocked",
            move || {
                stop.store(true, Ordering::Release);
                let _ = slow_control.shutdown(Shutdown::Both);
                drip.join().expect("drip client");
                real.join().expect("real callback client");
            },
        );
        let redirect = result.expect("real callback queued behind slow client");

        assert_eq!(redirect.code.as_deref(), Some("real-code"));
        assert_eq!(redirect.state.as_deref(), Some("real-state"));
    }

    #[test]
    fn parses_success_and_error_redirects() {
        let ok = parse_redirect_query("/callback?code=the%2Bcode&state=st8");
        assert_eq!(ok.code.as_deref(), Some("the+code"));
        assert_eq!(ok.state.as_deref(), Some("st8"));
        assert!(ok.error.is_none());

        let err = parse_redirect_query(
            "/callback?error=access_denied&error_description=User%20said%20no",
        );
        assert_eq!(err.error.as_deref(), Some("access_denied"));
        assert_eq!(err.error_description.as_deref(), Some("User said no"));
        assert!(err.code.is_none());
    }
}
