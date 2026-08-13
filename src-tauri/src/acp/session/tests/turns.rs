//! Driving one turn: the answer built out of updates, and how a turn ends.

use super::support::*;

#[test]
fn joins_one_message_and_ignores_other_updates() {
    let thought = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}}}"#;
    // A tool call *between* chunks of one identified message is not a
    // preamble boundary — the id already says they are the same message.
    let tool = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"c1","status":"pending"}}}"#;
    let mut sent = Vec::new();
    let text = run(
        transcript(
            &[&part("m1", "Adds "), thought, tool, &part("m1", "a spike.")],
            "end_turn",
        ),
        &mut sent,
    )
    .unwrap();
    assert_eq!(text, "Adds a spike.");
    // With no model pinned, set_model is skipped entirely — prompt is id 3.
    assert_eq!(
        requests(&sent),
        [
            (1, "initialize".into()),
            (2, "session/new".into()),
            (3, "session/prompt".into()),
        ]
    );
}

#[test]
fn announces_thinking_once_when_an_adapter_streams_thoughts() {
    // OpenCode can sit on thoughts with no tool titles; one Thinking…
    // label is enough to show the turn is alive.
    let thought = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}}}"#;
    let thought2 = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":" more"}}}}"#;
    let mut sent = Vec::new();
    let (text, progress) = run_with_progress(
        transcript(&[thought, thought2, &part("m1", "feat: done")], "end_turn"),
        &mut sent,
    )
    .unwrap();
    assert_eq!(text, "feat: done");
    assert_eq!(
        progress.iter().filter(|p| *p == "Thinking…").count(),
        1,
        "{progress:?}"
    );
}

#[test]
fn streams_tool_titles_and_writing_progress() {
    // The waiting UI needs more than a spinner: tool titles prove the agent
    // is working, and the first message chunk flips to "Writing…".
    let tool = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"c1","title":"Reading staged diff","kind":"execute","status":"pending"}}}"#;
    let kind_only = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"c2","kind":"search","status":"in_progress"}}}"#;
    let mut sent = Vec::new();
    let (text, progress) = run_with_progress(
        transcript(&[tool, kind_only, &part("m1", "feat: done")], "end_turn"),
        &mut sent,
    )
    .unwrap();
    assert_eq!(text, "feat: done");
    assert!(
        progress.iter().any(|p| p == "Reading staged diff"),
        "{progress:?}"
    );
    assert!(progress.iter().any(|p| p == "Searching…"), "{progress:?}");
    assert!(
        progress.iter().any(|p| p == "Writing the answer…"),
        "{progress:?}"
    );
    // Thought-style spam must not thrash the banner; writing is one-shot.
    assert_eq!(
        progress
            .iter()
            .filter(|p| *p == "Writing the answer…")
            .count(),
        1
    );
}

#[test]
fn keeps_only_the_final_message_so_narration_is_dropped() {
    // Exactly what both shipped adapters send: a preamble message, then the
    // answer as a separate message. Concatenating them put "…only the commit
    // message.feat: …" in the commit box.
    let text = run(
        transcript(
            &[
                &part("m1", "I’ll read the staged diff exactly once"),
                &part("m1", " and draft only the commit message."),
                &part("m2", "feat: increase timeout"),
                &part("m2", " and add retries"),
            ],
            "end_turn",
        ),
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(text, "feat: increase timeout and add retries");
}

#[test]
fn unwraps_the_code_fence_agents_answer_in() {
    // codex-acp fences with a language tag, claude-agent-acp with a bare
    // fence; both would otherwise land verbatim in the commit box.
    let tagged = run(
        transcript(
            &[&part("m1", "```text\\nfeat: tagged fence\\n```")],
            "end_turn",
        ),
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(tagged, "feat: tagged fence");
    let bare = run(
        transcript(
            &[&part(
                "m1",
                "```\\nfeat: bare fence\\n\\nWith a body.\\n```",
            )],
            "end_turn",
        ),
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(bare, "feat: bare fence\n\nWith a body.");
}

#[test]
fn leaves_an_unfenced_answer_and_an_inner_fence_alone() {
    let plain = run(
        transcript(&[&part("m1", "feat: plain\\n\\nA body.")], "end_turn"),
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(plain, "feat: plain\n\nA body.");
    // A body that quotes code is not "one fenced block" — unwrapping it
    // would eat the subject line.
    let quoting = run(
        transcript(
            &[&part("m1", "fix: escape backticks\\n\\n```\\ncode\\n```")],
            "end_turn",
        ),
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(quoting, "fix: escape backticks\n\n```\ncode\n```");
}

#[test]
fn falls_back_to_concatenation_without_message_ids() {
    // An adapter that omits `messageId` keeps the old behaviour rather than
    // losing the answer entirely.
    let text = run(
        transcript(&[&chunk("feat: "), &chunk("no ids here")], "end_turn"),
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(text, "feat: no ids here");
}

#[test]
fn drops_narration_that_arrived_before_tools() {
    // Cursor (and other v1 adapters) omit `messageId` and send a plan as
    // ordinary message chunks, then tools, then the answer. Concatenating
    // those chunks glued "I'll read the skill…" onto the result.
    let tool = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"c1","title":"Read skill","status":"pending"}}}"#;
    let text = run(
        transcript(
            &[
                &chunk("I'll read the skill and that commit's diff, then write the comment.\\n\\n"),
                tool,
                &chunk("**GL-371** Fold the WIP row into a merged diff"),
            ],
            "end_turn",
        ),
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(text, "**GL-371** Fold the WIP row into a merged diff");
}

#[test]
fn rejects_an_oversized_jsonrpc_frame() {
    let oversized = format!("{}\n", "x".repeat(MAX_FRAME_BYTES + 1));
    let error = await_result(
        &mut oversized.as_bytes(),
        &mut Vec::new(),
        1,
        &mut Answer::default(),
        None,
    )
    .unwrap_err();
    assert!(error.contains(&MAX_FRAME_BYTES.to_string()), "{error}");
}

#[test]
fn refuses_unsupported_requests_instead_of_hanging() {
    let ask =
        r#"{"jsonrpc":"2.0","id":90,"method":"fs/write_text_file","params":{"path":"/repo/x"}}"#;
    let mut sent = Vec::new();
    run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
    assert_eq!(reply_to(sent, 90)["error"]["code"], -32601);
}

#[test]
fn reports_a_refusal_and_a_silent_turn_distinctly() {
    assert_eq!(
        run(transcript(&[], "refusal"), &mut Vec::new()).unwrap_err(),
        "The agent declined to answer."
    );
    assert_eq!(
        run(transcript(&[], "end_turn"), &mut Vec::new()).unwrap_err(),
        "The agent returned no text."
    );
}

#[test]
fn surfaces_a_protocol_error_response() {
    let reader = Cursor::new(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"auth required\"}}\n"
            .to_string(),
    );
    assert_eq!(
        run(reader, &mut Vec::new()).unwrap_err(),
        "The agent reported an error: auth required"
    );
}

#[test]
fn tolerates_noise_and_a_truncated_stream() {
    // A banner line and a blank line must not derail the conversation.
    let reader = Cursor::new(format!(
        "warming up\n\n{}\n",
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#
    ));
    // …but a stream that ends before the answer is an error, not an empty
    // success (the mailbox flow's silent-timeout failure mode).
    assert_eq!(
        run(reader, &mut Vec::new()).unwrap_err(),
        "The agent exited before answering."
    );
}
