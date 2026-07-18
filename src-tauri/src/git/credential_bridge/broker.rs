//! Per-invocation credential broker for the re-entrant askpass helper.
//!
//! The parent GitLane process owns the keychain read and keeps the token in a
//! short-lived loopback server. The git/askpass environment carries only an
//! ephemeral address plus a 256-bit nonce; static keychain locators are never
//! enough to retrieve a token. The lease cancels and joins the server as soon as
//! the surrounding git command returns.

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_TOKEN_BYTES: usize = 16 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const SERVER_IO_TIMEOUT: Duration = Duration::from_millis(500);
const SERVER_CONNECTION_TIMEOUT: Duration = Duration::from_secs(2);
const ACCEPT_POLL: Duration = Duration::from_millis(10);
const MAX_IN_FLIGHT: usize = 8;

/// Keeps one command-scoped broker alive. This type is deliberately not
/// cloneable: one [`super::GitInvocation`] owns one broker lifetime.
pub(super) struct Lease {
    endpoint: String,
    nonce: String,
    cancel: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Lease {
    pub(super) fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub(super) fn nonce(&self) -> &str {
        &self.nonce
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Request {
    nonce: String,
    prompt: String,
}

#[derive(Serialize, Deserialize)]
struct Response {
    answer: Option<String>,
}

pub(super) fn start(expected_host: String, token: String) -> Result<Lease, String> {
    if token.is_empty() {
        return Err("No stored token is available for this account.".to_string());
    }
    if token.len() > MAX_TOKEN_BYTES {
        return Err("The stored provider token is unexpectedly large.".to_string());
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("Could not start the credential broker: {err}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|err| format!("Could not configure the credential broker: {err}"))?;
    let endpoint = listener
        .local_addr()
        .map_err(|err| format!("Could not address the credential broker: {err}"))?
        .to_string();
    let nonce = random_nonce()?;
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = cancel.clone();
    let worker_nonce = nonce.clone();
    let thread = std::thread::Builder::new()
        .name("gitlane-credential-broker".to_string())
        .spawn(move || {
            serve(
                listener,
                &expected_host,
                &token,
                &worker_nonce,
                &worker_cancel,
            )
        })
        .map_err(|err| format!("Could not launch the credential broker: {err}"))?;

    Ok(Lease {
        endpoint,
        nonce,
        cancel,
        thread: Some(thread),
    })
}

/// Ask the parent broker for one answer. Only loopback endpoints are accepted,
/// preventing a forged helper environment from turning GitLane into a network
/// client. All failures are silent so git emits its normal authentication error.
pub(super) fn request(endpoint: &str, nonce: &str, prompt: &str) -> Option<String> {
    if nonce.is_empty() || prompt.len() > MAX_REQUEST_BYTES {
        return None;
    }
    let address: SocketAddr = endpoint.parse().ok()?;
    if !address.ip().is_loopback() {
        return None;
    }

    let mut stream = TcpStream::connect_timeout(&address, IO_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok()?;
    let encoded = serde_json::to_vec(&Request {
        nonce: nonce.to_string(),
        prompt: prompt.to_string(),
    })
    .ok()?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return None;
    }
    stream.write_all(&encoded).ok()?;
    stream.flush().ok()?;
    stream.shutdown(Shutdown::Write).ok()?;

    let bytes = read_bounded(&mut stream, MAX_RESPONSE_BYTES)?;
    serde_json::from_slice::<Response>(&bytes).ok()?.answer
}

fn serve(
    listener: TcpListener,
    expected_host: &str,
    token: &str,
    nonce: &str,
    cancel: &AtomicBool,
) {
    let in_flight = Arc::new(AtomicUsize::new(0));
    std::thread::scope(|scope| {
        while !cancel.load(Ordering::Acquire) {
            let (stream, peer) = match listener.accept() {
                Ok(connection) => connection,
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(ACCEPT_POLL);
                    continue;
                }
                Err(_) => return,
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            if in_flight.fetch_add(1, Ordering::AcqRel) >= MAX_IN_FLIGHT {
                in_flight.fetch_sub(1, Ordering::AcqRel);
                continue;
            }
            let counter = in_flight.clone();
            scope.spawn(move || {
                let _slot = InFlightSlot(counter);
                serve_connection(stream, expected_host, token, nonce);
            });
        }
    });
}

struct InFlightSlot(Arc<AtomicUsize>);

impl Drop for InFlightSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn serve_connection(mut stream: TcpStream, expected_host: &str, token: &str, nonce: &str) {
    serve_connection_with_timeout(
        &mut stream,
        expected_host,
        token,
        nonce,
        SERVER_CONNECTION_TIMEOUT,
    );
}

fn serve_connection_with_timeout(
    stream: &mut TcpStream,
    expected_host: &str,
    token: &str,
    nonce: &str,
    timeout: Duration,
) {
    let Some(deadline) = Instant::now().checked_add(timeout) else {
        return;
    };
    let Some(bytes) = read_bounded_until(stream, MAX_REQUEST_BYTES, deadline) else {
        return;
    };
    let Ok(request) = serde_json::from_slice::<Request>(&bytes) else {
        return;
    };
    // Wrong capabilities receive no response at all, avoiding a useful
    // token-oracle signal and leaving the real invocation unaffected.
    if !constant_time_eq(request.nonce.as_bytes(), nonce.as_bytes()) {
        return;
    }

    let answer = match super::askpass_field(&request.prompt) {
        Some(super::AskpassField::Password) => match super::prompt_host(&request.prompt) {
            Some(host) if super::hosts_match(&host, expected_host) => Some(token.to_string()),
            _ => None,
        },
        _ => None,
    };
    if let Ok(encoded) = serde_json::to_vec(&Response { answer }) {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return;
        };
        let _ = stream.set_write_timeout(Some(remaining.min(SERVER_IO_TIMEOUT)));
        let _ = stream.write_all(&encoded);
        let _ = stream.flush();
    }
}

fn read_bounded_until(
    stream: &mut TcpStream,
    max_bytes: usize,
    deadline: Instant,
) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(max_bytes.min(4096));
    let mut buffer = [0u8; 4096];
    loop {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        stream
            .set_read_timeout(Some(remaining.min(SERVER_IO_TIMEOUT)))
            .ok()?;
        let allowed = max_bytes.saturating_add(1).saturating_sub(bytes.len());
        if allowed == 0 {
            return None;
        }
        let chunk_len = buffer.len().min(allowed);
        let read = stream.read(&mut buffer[..chunk_len]).ok()?;
        if read == 0 {
            return Some(bytes);
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > max_bytes {
            return None;
        }
    }
}

fn read_bounded(reader: &mut impl Read, max_bytes: usize) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(max_bytes.min(4096));
    reader
        .take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= max_bytes).then_some(bytes)
}

fn random_nonce() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|err| format!("Could not secure the credential broker: {err}"))?;
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    Ok(encoded)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD_PROMPT: &str = "Password for 'https://alice@gitlab.com': ";

    #[test]
    fn broker_requires_its_nonce_and_scoped_host() {
        let lease = start("gitlab.com".to_string(), "glpat-secret".to_string()).unwrap();

        assert_eq!(request(lease.endpoint(), "wrong", PASSWORD_PROMPT), None);
        assert_eq!(
            request(
                lease.endpoint(),
                lease.nonce(),
                "Password for 'https://alice@evil.example': "
            ),
            None
        );
        assert_eq!(
            request(lease.endpoint(), lease.nonce(), PASSWORD_PROMPT).as_deref(),
            Some("glpat-secret")
        );
    }

    #[test]
    fn broker_nonce_is_unique_and_dies_with_its_lease() {
        let first = start("gitlab.com".to_string(), "one".to_string()).unwrap();
        let endpoint = first.endpoint().to_string();
        let nonce = first.nonce().to_string();
        let second = start("gitlab.com".to_string(), "two".to_string()).unwrap();
        assert_ne!(nonce, second.nonce());

        drop(first);

        assert_eq!(request(&endpoint, &nonce, PASSWORD_PROMPT), None);
    }

    #[test]
    fn forged_non_loopback_endpoint_is_rejected() {
        assert_eq!(request("192.0.2.1:1234", "nonce", PASSWORD_PROMPT), None);
    }

    #[test]
    fn stalled_loopback_client_does_not_serialize_real_askpass() {
        let lease = start("gitlab.com".to_string(), "glpat-secret".to_string()).unwrap();
        let address: SocketAddr = lease.endpoint().parse().unwrap();
        let _stalled = TcpStream::connect(address).unwrap();
        // Let the accept loop hand the idle socket to its scoped worker.
        std::thread::sleep(ACCEPT_POLL * 3);

        let started = std::time::Instant::now();
        let answer = request(lease.endpoint(), lease.nonce(), PASSWORD_PROMPT);

        assert_eq!(answer.as_deref(), Some("glpat-secret"));
        assert!(
            started.elapsed() < SERVER_IO_TIMEOUT,
            "real askpass waited behind the stalled client: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn drip_feed_cannot_extend_the_connection_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(address).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        let timeout = Duration::from_millis(75);
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        // The drip feeder never sends a valid handshake, so this nonce is only
        // ever the mismatch side of the comparison; generate it the same way the
        // broker does rather than pinning a constant crypto value.
        let nonce = random_nonce().unwrap();

        let server_thread = std::thread::spawn(move || {
            let started = Instant::now();
            serve_connection_with_timeout(
                &mut server,
                "gitlab.com",
                "glpat-secret",
                &nonce,
                timeout,
            );
            finished_tx.send(started.elapsed()).unwrap();
        });
        let feeder = std::thread::spawn(move || loop {
            if client.write_all(b"{").is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        });

        let elapsed = finished_rx
            .recv_timeout(Duration::from_millis(250))
            .expect("drip feed held the broker past its hard deadline");
        assert!(
            elapsed >= Duration::from_millis(50),
            "connection did not exercise the drip-feed window: {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_millis(200),
            "connection exceeded its deadline: {elapsed:?}"
        );
        server_thread.join().unwrap();
        feeder.join().unwrap();
    }
}
