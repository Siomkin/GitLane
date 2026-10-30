use super::*;

fn request(prompt: &str, ssh_pid: u32) -> Request {
    Request {
        nonce: String::new(),
        prompt: prompt.into(),
        ssh_pid,
    }
}

#[test]
fn host_key_questions_are_told_apart_from_secrets() {
    assert_eq!(
        classify("The authenticity of host 'devbox (10.0.0.2)' can't be established.\nED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "),
        SshPromptKind::HostKey
    );
    assert_eq!(classify("me@devbox's password: "), SshPromptKind::Secret);
    assert_eq!(
        classify("Enter passphrase for key '/home/me/.ssh/id_ed25519': "),
        SshPromptKind::Secret
    );
}

#[test]
fn a_second_ssh_gets_the_answer_without_asking_again() {
    let mut remembered = None;
    let mut asked = 0;
    let mut ask = |_: &str, _: SshPromptKind| {
        asked += 1;
        Some("hunter2".to_string())
    };
    let prompt = "me@devbox's password: ";
    assert_eq!(
        decide(&request(prompt, 10), &mut remembered, &mut ask).as_deref(),
        Some("hunter2")
    );
    assert_eq!(
        decide(&request(prompt, 11), &mut remembered, &mut ask).as_deref(),
        Some("hunter2")
    );
    assert_eq!(asked, 1);
}

#[test]
fn the_same_ssh_asking_again_means_a_wrong_answer_so_the_user_is_asked() {
    let mut remembered = None;
    let mut asked = 0;
    let mut ask = |_: &str, _: SshPromptKind| {
        asked += 1;
        Some(format!("try{asked}"))
    };
    let prompt = "me@devbox's password: ";
    decide(&request(prompt, 10), &mut remembered, &mut ask);
    assert_eq!(
        decide(&request(prompt, 10), &mut remembered, &mut ask).as_deref(),
        Some("try2")
    );
    assert_eq!(asked, 2);
}

#[test]
fn a_cancel_or_a_host_key_answer_is_not_remembered() {
    let mut remembered = None;
    decide(&request("password: ", 1), &mut remembered, |_, _| None);
    assert!(remembered.is_none());
    decide(
        &request("Are you sure you want to continue connecting (yes/no)? ", 1),
        &mut remembered,
        |_, _| Some("yes".into()),
    );
    assert!(remembered.is_none());
}

#[test]
fn the_helper_round_trips_through_the_listener_and_checks_the_nonce() {
    let ask: Ask = Arc::new(|prompt, kind| {
        assert_eq!(kind, SshPromptKind::Secret);
        Some(format!("answer to {prompt}"))
    });
    let lease = start("ssh://askpass-test", ask).unwrap();
    let env: HashMap<_, _> = env_for("ssh://askpass-test").unwrap().into_iter().collect();
    assert_eq!(env["SSH_ASKPASS_REQUIRE"], "force");
    let endpoint = &env[ENV_ENDPOINT];
    let nonce = &env[ENV_NONCE];
    assert_eq!(
        ask_app(endpoint, nonce, "pw: ", 7).as_deref(),
        Some("answer to pw: ")
    );
    assert_eq!(ask_app(endpoint, "wrong", "pw: ", 8), None);
    drop(lease);
    assert!(env_for("ssh://askpass-test").is_none());
}
