//! End-to-end proofs against a real `git`: the `GIT_ASKPASS` bridge supplies the
//! password git sends over the wire, and the gh helper answers with the bound
//! login's token. Credentials come entirely from the helpers, never from the
//! frontend. The keychain read itself is covered by the parent module's unit
//! tests; here the helpers are small scripts so the tests stay hermetic (no OS
//! keychain, no real `gh`) and run on headless CI.

use super::*;
use crate::secrets::MemoryStore;
use base64::Engine;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::os::unix::fs::PermissionsExt;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const UNAUTHORIZED: &[u8] = b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"t\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/// Removes a scratch dir even when an assert fails.
pub(super) struct Scratch(pub(super) std::path::PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn git_fetch_sends_the_password_from_the_askpass_bridge() {
    let scratch = Scratch(std::env::temp_dir().join(format!(
        "gitlane-bridge-{}-{}",
        std::process::id(),
        unique_id()
    )));
    let dir = &scratch.0;
    std::fs::create_dir_all(dir).unwrap();

    // A throwaway repo to run `git -C` against.
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    assert!(crate::git::isolated_git_command()
        .args(["init", "-q", repo.to_str().unwrap()])
        .status()
        .expect("git init launches")
        .success());

    // An askpass helper answering git's Username/Password prompts — this
    // stands in for the real re-entrant binary, which asks the parent broker
    // for the password (see `answers_username_from_env_and_password...`).
    let askpass = dir.join("askpass.sh");
    std::fs::write(
        &askpass,
        "#!/bin/sh\ncase \"$1\" in\n  Username*) printf 'testuser' ;;\n  *) printf 's3cr3t-token' ;;\nesac\n",
    )
    .unwrap();
    std::fs::set_permissions(&askpass, std::fs::Permissions::from_mode(0o755)).unwrap();

    // Still 401 on the right password: only the header matters here.
    let expected = basic_auth("testuser", "s3cr3t-token");
    let (addr, handle) = serve_until_authorized(expected.clone(), UNAUTHORIZED.to_vec());

    // Build the invocation exactly as production does, but point GIT_ASKPASS
    // at the stub helper instead of the app binary.
    let bridge = ProviderTokenBridge {
        credential_host: format!("{addr}"),
        username: "testuser".into(),
        provider: "gitlab".into(),
        account_id: "1".into(),
    };
    let store = MemoryStore::new();
    store
        .set(
            &SecretKey::new("gitlab", &format!("{addr}"), "1"),
            "broker-token-unused-by-stub",
        )
        .unwrap();
    let inv = provider_token_invocation(&bridge, askpass.to_str().unwrap(), &store).unwrap();

    let url = format!("http://testuser@{addr}/repo.git");
    let mut args: Vec<String> = vec!["-C".into(), repo.to_str().unwrap().into()];
    args.extend(inv.config.clone());
    args.extend(["fetch".into(), url, "HEAD".into()]);

    let mut cmd = crate::git::isolated_git_command();
    cmd.args(&args)
        // Hermetic: ignore the developer's real git config / helpers.
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("NO_PROXY", "*");
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }
    // The fetch fails (the server is not a real git host); we only assert the
    // token reached the wire via askpass.
    let _ = cmd.output();
    let seen = handle.join().expect("server thread joins");

    assert!(
        seen.iter().any(|h| h == &expected),
        "git should authenticate with the askpass-provided token; saw {seen:?}"
    );
}

/// Real `git credential` runs through the gh helper config, with a stub `gh`
/// first on PATH. Proves the `-c` value survives git's parsing, that the
/// bound login's token is what git receives whatever URL username it asks
/// about (on github.com via `GH_TOKEN`, on GHES via `GH_ENTERPRISE_TOKEN`),
/// that a login gh has no token for fails closed, and that `store` never
/// resolves a token.
#[test]
fn gh_helper_answers_with_the_bound_logins_token_and_fails_closed() {
    let scratch = Scratch(std::env::temp_dir().join(format!(
        "gitlane-gh-helper-{}-{}",
        std::process::id(),
        unique_id()
    )));
    let dir = &scratch.0;
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let calls = dir.join("token-calls");
    // `gh auth token --hostname H --user U` knows only bob, on github.com and
    // on a GHES host, and logs every lookup. Like real gh, `auth git-credential
    // get` answers github.com from GH_TOKEN and any other host from
    // GH_ENTERPRISE_TOKEN.
    let gh = bin.join("gh");
    std::fs::write(
        &gh,
        "#!/bin/sh\n\
         case \"$1 $2\" in\n\
         'auth token') echo \"$4 $6\" >> \"$GITLANE_STUB_CALLS\"; [ \"$6\" = bob ] || exit 1;\n\
           case \"$4\" in github.com) echo tok-bob ;; ghe.example.test) echo tok-ghes ;; *) exit 1 ;; esac ;;\n\
         'auth git-credential') [ \"$3\" = get ] || { cat >/dev/null; exit 0; };\n\
           host=$(sed -n 's/^host=//p');\n\
           if [ \"$host\" = github.com ]; then t=$GH_TOKEN; else t=$GH_ENTERPRISE_TOKEN; fi;\n\
           printf 'username=x-access-token\\npassword=%s\\n' \"$t\" ;;\n\
         esac\n",
    )
    .unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let git = |host: &str, login: &str, action: &str, input: String| {
        let inv = git_invocation(&TransportCredential::Gh {
            host: host.into(),
            gh_host: host.into(),
            login: login.into(),
        })
        .unwrap();
        let mut cmd = crate::git::isolated_git_command();
        cmd.args(&inv.config)
            .args(["credential", action])
            // Hermetic: never reach the developer's own helpers / keychain.
            .env("PATH", &path)
            .env("HOME", dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "")
            .env("GITLANE_STUB_CALLS", &calls)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        for key in [
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GH_ENTERPRISE_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
        ] {
            cmd.env_remove(key);
        }
        let mut child = cmd.spawn().expect("git launches");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        child.wait_with_output().expect("git credential exits")
    };
    // git asks about the URL username `alice`; the pin must win.
    let fill = |host: &str, login: &str| {
        git(
            host,
            login,
            "fill",
            format!("protocol=https\nhost={host}\nusername=alice\n\n"),
        )
    };
    let password = |out: &std::process::Output| {
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|l| l.strip_prefix("password=").map(str::to_string))
    };

    let bound = fill("github.com", "bob");
    assert!(bound.status.success(), "{bound:?}");
    assert_eq!(password(&bound).as_deref(), Some("tok-bob"));

    let ghes = fill("ghe.example.test", "bob");
    assert!(ghes.status.success(), "{ghes:?}");
    assert_eq!(password(&ghes).as_deref(), Some("tok-ghes"));

    let unknown = fill("github.com", "carol");
    assert!(!unknown.status.success(), "{unknown:?}");
    assert_eq!(password(&unknown), None);

    // `store` (sent after a successful auth) must not touch the keychain.
    std::fs::write(&calls, "").unwrap();
    let stored = git(
        "github.com",
        "bob",
        "approve",
        "protocol=https\nhost=github.com\nusername=x-access-token\npassword=tok-bob\n\n".into(),
    );
    assert!(stored.status.success(), "{stored:?}");
    assert_eq!(std::fs::read_to_string(&calls).unwrap(), "");
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
