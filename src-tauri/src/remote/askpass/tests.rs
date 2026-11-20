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
        classify(
            "The authenticity of host 'devbox (10.0.0.2)' can't be established.\nED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "
        ),
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
        decide(&request(prompt, 10), &mut remembered, true, &mut ask).as_deref(),
        Some("hunter2")
    );
    assert_eq!(
        decide(&request(prompt, 11), &mut remembered, true, &mut ask).as_deref(),
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
    decide(&request(prompt, 10), &mut remembered, true, &mut ask);
    assert_eq!(
        decide(&request(prompt, 10), &mut remembered, true, &mut ask).as_deref(),
        Some("try2")
    );
    assert_eq!(asked, 2);
}

#[test]
fn a_prompt_naming_no_host_is_never_replayed_to_another_ssh() {
    // A server's keyboard-interactive prompt ("Password: ") names no host, so a
    // second ssh asking it may be talking to a different server (e.g. a ProxyJump hop).
    let mut remembered = None;
    let mut asked = 0;
    let mut ask = |_: &str, _: SshPromptKind| {
        asked += 1;
        Some(format!("secret{asked}"))
    };
    decide(&request("Password: ", 10), &mut remembered, true, &mut ask);
    assert_eq!(
        decide(&request("Password: ", 11), &mut remembered, true, &mut ask).as_deref(),
        Some("secret2")
    );
    assert_eq!(asked, 2);
}

/// How many of `prompts` (text, ssh pid) reach the user in one attempt.
fn times_asked(prompts: &[(&str, u32)], replay_named: bool) -> usize {
    let mut remembered = None;
    let mut asked = 0;
    for &(prompt, pid) in prompts {
        decide(
            &request(prompt, pid),
            &mut remembered,
            replay_named,
            |_, _| {
                asked += 1;
                Some(format!("secret{asked}"))
            },
        );
    }
    asked
}

#[test]
fn an_older_ssh_never_gets_a_replayed_answer() {
    let prompt = "me@devbox's password: ";
    assert_eq!(times_asked(&[(prompt, 10), (prompt, 11)], false), 2);
    assert_eq!(times_asked(&[(prompt, 0), (prompt, 0)], false), 2);
}

#[test]
fn prompts_for_different_hosts_are_kept_apart() {
    let hops = [("(me@jump) Password: ", 10), ("(me@devbox) Password: ", 11)];
    assert_eq!(times_asked(&hops, true), 2);
}

#[test]
fn a_server_cannot_borrow_another_hosts_prompt() {
    let forged = [
        ("me@jump's password: ", 10),
        ("(me@devbox) me@jump's password: ", 11),
    ];
    assert_eq!(times_asked(&forged, true), 2);
}

#[test]
fn without_a_pid_only_a_named_prompt_is_replayed_once() {
    let named = "me@devbox's password: ";
    assert_eq!(times_asked(&[(named, 0), (named, 0), (named, 0)], true), 2);
    assert_eq!(
        times_asked(&[("Password: ", 0), ("Password: ", 0)], true),
        2
    );
}

#[test]
fn a_cancel_or_a_host_key_answer_is_not_remembered() {
    let mut remembered = None;
    decide(&request("password: ", 1), &mut remembered, true, |_, _| {
        None
    });
    assert!(remembered.is_none());
    decide(
        &request("Are you sure you want to continue connecting (yes/no)? ", 1),
        &mut remembered,
        true,
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
    let lease = start(
        "ssh://askpass-test",
        ask,
        vec!["-i".into(), "/k".into()],
        true,
    )
    .unwrap();
    let context = context_for("ssh://askpass-test").unwrap();
    assert_eq!(context.args, ["-i", "/k"]);
    let env: HashMap<_, _> = context.env.into_iter().collect();
    assert_eq!(env["SSH_ASKPASS_REQUIRE"], "force");
    let endpoint = &env[ENV_ENDPOINT];
    let nonce = &env[ENV_NONCE];
    assert_eq!(
        ask_app(endpoint, nonce, "pw: ", 7).as_deref(),
        Some("answer to pw: ")
    );
    // Any other nonce is refused: a fresh one is as wrong as it gets.
    let other = random_nonce().unwrap();
    assert_eq!(ask_app(endpoint, &other, "pw: ", 8), None);
    drop(lease);
    assert!(context_for("ssh://askpass-test").is_none());
}

#[test]
fn the_listener_reuses_an_answer_only_when_started_for_a_marking_ssh() {
    for (replay_named, expected_asks) in [(true, 1), (false, 2)] {
        let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = asked.clone();
        let ask: Ask = Arc::new(move |_, _| {
            counter.fetch_add(1, Ordering::Relaxed);
            Some("pw".into())
        });
        let origin = format!("ssh://askpass-replay-{replay_named}");
        let lease = start(&origin, ask, vec![], replay_named).unwrap();
        let env: HashMap<_, _> = context_for(&origin).unwrap().env.into_iter().collect();
        let prompt = "me@devbox's password: ";
        for ssh_pid in [21, 22] {
            let answer = ask_app(&env[ENV_ENDPOINT], &env[ENV_NONCE], prompt, ssh_pid);
            assert_eq!(answer.as_deref(), Some("pw"));
        }
        assert_eq!(
            asked.load(Ordering::Relaxed),
            expected_asks,
            "{replay_named}"
        );
        drop(lease);
    }
}

#[test]
fn a_waiting_question_stays_listable_until_answered() {
    let prompts = Arc::new(SshPrompts::default());
    let asking = prompts.clone();
    let waiter = std::thread::spawn(move || {
        asking.ask(
            |id| SshPromptEvent {
                id,
                origin: "ssh://devbox".into(),
                prompt: "password: ".into(),
                kind: SshPromptKind::Secret,
            },
            |_| {},
        )
    });
    let pending = loop {
        let pending = prompts.pending();
        if !pending.is_empty() {
            break pending;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    assert_eq!(pending[0].prompt, "password: ");
    prompts.answer(pending[0].id, Some("pw".into()));
    assert_eq!(waiter.join().unwrap().as_deref(), Some("pw"));
    assert!(prompts.pending().is_empty());
}

#[test]
fn a_question_that_fails_still_closes_its_flag() {
    let flag = AtomicBool::new(false);
    let asked = std::panic::catch_unwind(|| {
        let _open = Prompting::open(&flag);
        assert!(flag.load(Ordering::Relaxed), "open while asking");
        panic!("the prompt failed");
    });
    assert!(asked.is_err());
    assert!(
        !flag.load(Ordering::Relaxed),
        "a failed question must not pause the connect timeout for good"
    );
}
