//! `run_sign_in_inner` end to end over Bitbucket's PKCE flow. The test answers
//! the real loopback socket the way a browser redirect would.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread::JoinHandle;

use super::support::*;

/// Answers the PKCE loopback the way a browser redirect would, reading the
/// port and `state` from the authorize URL the flow reports.
fn redirect_to_loopback(authorize_url: &str) -> JoinHandle<()> {
    let param = |name: &str| -> String {
        let start = authorize_url.find(&format!("{name}=")).unwrap() + name.len() + 1;
        let rest = &authorize_url[start..];
        rest[..rest.find('&').unwrap_or(rest.len())].to_string()
    };
    // redirect_uri is `http%3A%2F%2F127.0.0.1%3A<port>%2Fcallback`.
    let redirect_uri = param("redirect_uri");
    let after_host =
        &redirect_uri[redirect_uri.find("127.0.0.1%3A").unwrap() + "127.0.0.1%3A".len()..];
    let port: u16 = after_host[..after_host.find('%').unwrap()].parse().unwrap();
    // `state` is base64url, which percent-encoding leaves unchanged.
    let state = param("state");
    std::thread::spawn(move || {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            stream,
            "GET /callback?code=auth-code-1&state={state} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
        )
        .unwrap();
        let mut page = String::new();
        let _ = stream.read_to_string(&mut page);
    })
}

#[test]
fn the_pkce_flow_reports_each_step_in_order_and_stores_the_token() {
    let dir = TempData::new("pkce");
    client_ids::set(&dir.0, "bitbucket", "bitbucket.org", "bb-client").unwrap();
    let recorder = Recorder::default();
    let browser = Mutex::new(None::<JoinHandle<()>>);
    let progress = |p: &ProviderOauthProgress| {
        recorder.record(p);
        if p.step == "browser" {
            let url = p.verification_uri.as_deref().unwrap();
            *browser.lock().unwrap() = Some(redirect_to_loopback(url));
        }
    };
    let http = MockTransport::new(vec![
        MockTransport::ok(
            200,
            &format!(r#"{{"access_token":"{TOKEN}","token_type":"bearer"}}"#),
        ),
        MockTransport::ok(
            200,
            r#"{"uuid":"{abc-123}","username":"grace","display_name":"Grace H."}"#,
        ),
    ]);
    let store = MemoryStore::new();
    let env = SignInEnv {
        progress: &progress,
        client_ids_dir: Some(&dir.0),
        http: &http,
        store: &store,
        clock: &InstantClock::new(),
    };

    let result = run_sign_in_inner(&env, new_slot(), "bitbucket", "bitbucket.org").unwrap();
    if let Some(handle) = browser.lock().unwrap().take() {
        handle.join().unwrap();
    }

    assert_eq!(
        recorder.steps(),
        ["browser", "waiting", "authorized", "storing"]
    );
    assert_eq!(result.login, "grace");
    assert_eq!(result.transport_username, "x-token-auth");
    assert_eq!(
        stored_token(&store, "bitbucket", "bitbucket.org", "{abc-123}").as_deref(),
        Some(TOKEN)
    );
    // The code from the redirect is what was exchanged.
    let requests = http.requests.lock().unwrap();
    assert!(requests[0]
        .form
        .contains(&("code".into(), "auth-code-1".into())));
    for payload in recorder.wire_payloads() {
        assert!(
            !payload.contains(TOKEN),
            "token leaked into progress: {payload}"
        );
    }
}
