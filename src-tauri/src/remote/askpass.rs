//! In-app answers to the questions `ssh` asks while connecting
//! (remote-ssh-repos D4): a password, a key passphrase, a one-time code, or
//! whether to trust a new host key.
//!
//! `ssh` runs this binary as its `SSH_ASKPASS` helper (`SSH_ASKPASS_REQUIRE=
//! force`). The helper sends the prompt to the running app over a loopback
//! listener that lives for one connect attempt. Its environment carries the
//! address and a 256-bit nonce, never argv. The app asks the user, and the
//! answer goes back to the helper alone, which prints it for `ssh`.
//!
//! One connect runs several `ssh` processes (probe, upload, session). The
//! listener remembers the last answer for that attempt only, in memory, and
//! replays it when a *different* `ssh` asks the identical question. The same
//! `ssh` asking again means the answer was wrong, so the user is asked again.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::git::credential_bridge::{constant_time_eq, random_nonce};
use crate::git::types::SshPromptKind;

const FLAG: &str = "GITLANE_SSH_ASKPASS";
const ENV_ENDPOINT: &str = "GITLANE_SSH_ASKPASS_ENDPOINT";
const ENV_NONCE: &str = "GITLANE_SSH_ASKPASS_NONCE";
const MAX_BYTES: usize = 8 * 1024;
/// How long a person may take over one question.
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(600);
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const ACCEPT_POLL: Duration = Duration::from_millis(20);

#[derive(Serialize, Deserialize)]
struct Request {
    nonce: String,
    prompt: String,
    /// The asking `ssh` (the helper's parent); 0 where unknown.
    ssh_pid: u32,
}

#[derive(Serialize, Deserialize)]
struct Response {
    answer: Option<String>,
}

/// Asks the user `prompt` and waits for the answer; `None` is a cancel.
pub type Ask = Arc<dyn Fn(&str, SshPromptKind) -> Option<String> + Send + Sync>;

/// A host-key confirmation, or a question whose answer is a secret.
pub fn classify(prompt: &str) -> SshPromptKind {
    if prompt.to_ascii_lowercase().contains("continue connecting") {
        SshPromptKind::HostKey
    } else {
        SshPromptKind::Secret
    }
}

/// Whether `ssh` spawned this process as its askpass helper.
pub fn is_invocation() -> bool {
    std::env::var_os(FLAG).is_some()
}

/// The helper: forward `ssh`'s prompt (argv[1]) to the app and print the
/// answer. Exits non-zero on cancel or any failure, which `ssh` reads as "no
/// answer". Nothing is written to stderr; the answer goes to stdout only.
pub fn respond() -> ! {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let endpoint = std::env::var(ENV_ENDPOINT).unwrap_or_default();
    let nonce = std::env::var(ENV_NONCE).unwrap_or_default();
    #[cfg(unix)]
    let ssh_pid = std::os::unix::process::parent_id();
    #[cfg(not(unix))]
    let ssh_pid = 0;
    match ask_app(&endpoint, &nonce, &prompt, ssh_pid) {
        Some(answer) => {
            let mut out = std::io::stdout();
            let _ = out.write_all(answer.as_bytes());
            let _ = out.write_all(b"\n");
            let _ = out.flush();
            std::process::exit(0)
        }
        None => std::process::exit(1),
    }
}

fn ask_app(endpoint: &str, nonce: &str, prompt: &str, ssh_pid: u32) -> Option<String> {
    let address: SocketAddr = endpoint.parse().ok()?;
    if !address.ip().is_loopback() || nonce.is_empty() || prompt.len() > MAX_BYTES {
        return None;
    }
    let mut stream = TcpStream::connect_timeout(&address, IO_TIMEOUT).ok()?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok()?;
    stream
        .set_read_timeout(Some(PROMPT_TIMEOUT + IO_TIMEOUT * 5))
        .ok()?;
    let request = serde_json::to_vec(&Request {
        nonce: nonce.into(),
        prompt: prompt.into(),
        ssh_pid,
    })
    .ok()?;
    stream.write_all(&request).ok()?;
    stream.shutdown(Shutdown::Write).ok()?;
    let bytes = read_bounded(&mut stream)?;
    serde_json::from_slice::<Response>(&bytes).ok()?.answer
}

fn read_bounded(reader: &mut impl Read) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= MAX_BYTES).then_some(bytes)
}

/// What every `ssh` of an origin's connect in progress needs: the askpass
/// environment, extra arguments (a saved connection's key file), and whether
/// one of its questions is waiting on the user.
struct Active {
    env: Vec<(String, String)>,
    args: Vec<String>,
    prompting: Arc<AtomicBool>,
}

static ACTIVE: LazyLock<Mutex<HashMap<String, Active>>> = LazyLock::new(Default::default);

/// The environment that routes `origin`'s `ssh` questions to the app and the
/// connect's extra `ssh` arguments, or `None` when no connect is in progress
/// for it (then `ssh` runs in batch mode).
pub fn context_for(origin: &str) -> Option<SshContext> {
    let active = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    active.get(origin).map(|a| SshContext {
        env: a.env.clone(),
        args: a.args.clone(),
    })
}

/// See [`context_for`].
pub struct SshContext {
    pub env: Vec<(String, String)>,
    pub args: Vec<String>,
}

/// Whether one of `origin`'s questions is waiting on the user; the connect
/// watchdog does not count that time.
pub fn prompting(origin: &str) -> bool {
    let active = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    active
        .get(origin)
        .is_some_and(|a| a.prompting.load(Ordering::Relaxed))
}

/// Keeps one origin's listener for one connect attempt; dropping it stops the
/// listener and forgets any remembered answer.
pub struct Lease {
    origin: String,
    cancel: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        ACTIVE
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.origin);
        self.cancel.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Start answering `origin`'s `ssh` questions through `ask`; every `ssh` of
/// this connect also gets `ssh_args`.
pub fn start(origin: &str, ask: Ask, ssh_args: Vec<String>) -> Result<Lease, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Could not locate GitLane: {e}"))?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.set_nonblocking(true).map(|()| l))
        .map_err(|e| format!("Could not start the sign-in prompt: {e}"))?;
    let endpoint = listener
        .local_addr()
        .map_err(|e| format!("Could not start the sign-in prompt: {e}"))?
        .to_string();
    let nonce = random_nonce()?;
    let prompting = Arc::new(AtomicBool::new(false));
    let cancel = Arc::new(AtomicBool::new(false));
    let env = vec![
        ("SSH_ASKPASS".into(), exe.to_string_lossy().into_owned()),
        ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
        (FLAG.into(), "1".into()),
        (ENV_ENDPOINT.into(), endpoint),
        (ENV_NONCE.into(), nonce.clone()),
    ];
    ACTIVE.lock().unwrap_or_else(|p| p.into_inner()).insert(
        origin.to_string(),
        Active {
            env,
            args: ssh_args,
            prompting: prompting.clone(),
        },
    );
    let worker_cancel = cancel.clone();
    let thread = std::thread::Builder::new()
        .name("gitlane-ssh-askpass".into())
        .spawn(move || serve(listener, &nonce, &ask, &prompting, &worker_cancel))
        .map_err(|e| format!("Could not start the sign-in prompt: {e}"))?;
    Ok(Lease {
        origin: origin.to_string(),
        cancel,
        thread: Some(thread),
    })
}

/// The last answer this attempt gave, and which `ssh` it went to.
struct Remembered {
    prompt: String,
    answer: String,
    ssh_pid: u32,
}

fn serve(
    listener: TcpListener,
    nonce: &str,
    ask: &Ask,
    prompting: &AtomicBool,
    cancel: &AtomicBool,
) {
    let mut remembered: Option<Remembered> = None;
    while !cancel.load(Ordering::Acquire) {
        let Ok((stream, _)) = listener.accept() else {
            std::thread::sleep(ACCEPT_POLL);
            continue;
        };
        let _ = answer_one(stream, nonce, ask, prompting, &mut remembered);
    }
}

fn answer_one(
    mut stream: TcpStream,
    nonce: &str,
    ask: &Ask,
    prompting: &AtomicBool,
    remembered: &mut Option<Remembered>,
) -> Option<()> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok()?;
    let request: Request = serde_json::from_slice(&read_bounded(&mut stream)?).ok()?;
    let answer = if !constant_time_eq(request.nonce.as_bytes(), nonce.as_bytes()) {
        None
    } else {
        decide(&request, remembered, |prompt, kind| {
            prompting.store(true, Ordering::Relaxed);
            let answer = ask(prompt, kind);
            prompting.store(false, Ordering::Relaxed);
            answer
        })
    };
    let response = serde_json::to_vec(&Response { answer }).ok()?;
    stream.write_all(&response).ok()
}

/// Replay the remembered answer to a different `ssh` asking the same question;
/// otherwise ask, and remember a secret answer for the rest of the attempt.
fn decide(
    request: &Request,
    remembered: &mut Option<Remembered>,
    ask: impl FnOnce(&str, SshPromptKind) -> Option<String>,
) -> Option<String> {
    if let Some(r) = remembered.as_mut() {
        if r.prompt == request.prompt && (r.ssh_pid != request.ssh_pid || request.ssh_pid == 0) {
            r.ssh_pid = request.ssh_pid;
            // A pid of 0 can't tell a retry from a new process: replay once.
            let answer = r.answer.clone();
            if request.ssh_pid == 0 {
                *remembered = None;
            }
            return Some(answer);
        }
    }
    let kind = classify(&request.prompt);
    let answer = ask(&request.prompt, kind);
    *remembered = match (&answer, kind) {
        (Some(answer), SshPromptKind::Secret) => Some(Remembered {
            prompt: request.prompt.clone(),
            answer: answer.clone(),
            ssh_pid: request.ssh_pid,
        }),
        _ => None,
    };
    answer
}

/// Tauri-managed: questions shown to the user and waiting for
/// `answer_ssh_prompt`, by event id.
#[derive(Default)]
pub struct SshPrompts {
    next: std::sync::atomic::AtomicU64,
    waiting: Mutex<HashMap<u64, std::sync::mpsc::Sender<Option<String>>>>,
}

impl SshPrompts {
    /// Register a question; `show` publishes it under the returned id, then
    /// this waits up to [`PROMPT_TIMEOUT`] for the answer.
    pub fn ask(&self, show: impl FnOnce(u64)) -> Option<String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::channel();
        self.waiting
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, tx);
        show(id);
        let answer = rx.recv_timeout(PROMPT_TIMEOUT).ok().flatten();
        self.waiting
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        answer
    }

    /// Hand the user's answer (or `None` for cancel) to question `id`. An
    /// unknown or expired id is ignored.
    pub fn answer(&self, id: u64, answer: Option<String>) {
        if let Some(tx) = self
            .waiting
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id)
        {
            let _ = tx.send(answer);
        }
    }
}

#[cfg(test)]
mod tests;
