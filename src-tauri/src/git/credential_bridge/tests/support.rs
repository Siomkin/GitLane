//! Fixtures shared by the real-`git` tests: a self-removing scratch dir and a
//! local HTTP server that demands Basic auth.

use base64::Engine;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub(super) const UNAUTHORIZED: &[u8] = b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"t\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/// Removes a scratch dir even when an assert fails.
pub(super) struct Scratch(pub(super) std::path::PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn basic_auth(username: &str, password: &str) -> String {
    let credentials = format!("{username}:{password}");
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(credentials)
    )
}

/// A local server answering 401 until a request carries `want`, then `accepted`,
/// so git escalates from an anonymous request to the askpass password. Returns
/// every Authorization header it saw. The deadline keeps it from hanging a test.
pub(super) fn serve_until_authorized(
    want: String,
    accepted: Vec<u8>,
) -> (SocketAddr, JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind local test server");
    listener
        .set_nonblocking(true)
        .expect("nonblocking listener");
    let addr = listener.local_addr().expect("local addr");
    let handle = std::thread::spawn(move || {
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let (mut stream, _) = match listener.accept() {
                Ok(conn) => conn,
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                Err(_) => break,
            };
            // macOS sockets inherit the listener's non-blocking mode.
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let mut buf = [0u8; 2048];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let auth = req
                .lines()
                .find_map(|l| l.strip_prefix("Authorization: ").map(str::to_string));
            let done = auth.as_deref() == Some(want.as_str());
            seen.extend(auth);
            let _ = stream.write_all(if done { &accepted } else { UNAUTHORIZED });
            // Stop once the token lands rather than waiting out the deadline.
            if done {
                break;
            }
        }
        seen
    });
    (addr, handle)
}

pub(super) fn unique_id() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}
