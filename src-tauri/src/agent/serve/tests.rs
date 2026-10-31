use std::io::{Cursor, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::serve;
use crate::agent::protocol::{self, Request, COMPRESS_ABOVE};
use crate::agent::run::{dispatch, Progress};
use crate::commands::CommandError;

/// An output the test can read back after the loop returns.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Captured {
    fn lines(&self) -> Vec<Vec<u8>> {
        let bytes = self.0.lock().unwrap().clone();
        bytes
            .split(|b| *b == b'\n')
            .filter(|l| !l.is_empty())
            .map(<[u8]>::to_vec)
            .collect()
    }
    fn frames(&self) -> Vec<Value> {
        self.lines()
            .iter()
            .map(|l| protocol::decode(l).unwrap())
            .collect()
    }
}

/// Run the loop over `input` with `handler` and return what it wrote.
fn drive<H, F>(input: &str, handler: H) -> Captured
where
    H: Fn(Request, Progress) -> F,
    F: std::future::Future<Output = Result<Value, CommandError>> + Send + 'static,
{
    let out = Captured::default();
    serve(
        Cursor::new(input.to_string()),
        out.clone(),
        json!({ "hello": { "test": true } }),
        handler,
    );
    out
}

fn ids(frames: &[Value]) -> Vec<u64> {
    frames.iter().filter_map(|f| f["id"].as_u64()).collect()
}

#[test]
fn hello_comes_first_and_every_request_is_answered_by_id() {
    let out = drive(
        "{\"id\":1,\"cmd\":\"echo\",\"args\":{\"n\":1}}\n{\"id\":2,\"cmd\":\"echo\",\"args\":{\"n\":2}}\n",
        |req, _| async move { Ok(req.args) },
    );
    let frames = out.frames();
    assert!(frames[0].get("hello").is_some(), "{frames:?}");
    let mut answered = ids(&frames[1..]);
    answered.sort();
    assert_eq!(answered, vec![1, 2]);
    for frame in &frames[1..] {
        assert_eq!(frame["ok"]["n"], frame["id"]);
    }
}

#[test]
fn a_slow_request_does_not_hold_back_a_fast_one() {
    let out = drive(
        "{\"id\":1,\"cmd\":\"slow\"}\n{\"id\":2,\"cmd\":\"fast\"}\n",
        |req, _| async move {
            if req.cmd == "slow" {
                tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_millis(300)))
                    .await
                    .unwrap();
            }
            Ok(json!(req.cmd))
        },
    );
    assert_eq!(ids(&out.frames()[1..]), vec![2, 1]);
}

#[test]
fn progress_events_carry_the_request_id_and_precede_its_response() {
    let out = drive("{\"id\":7,\"cmd\":\"work\"}\n", |_, progress| async move {
        progress(crate::events::HANDOFF_PROGRESS, json!({ "step": "one" }));
        progress(crate::events::HANDOFF_PROGRESS, json!({ "step": "two" }));
        Ok(json!("done"))
    });
    let frames = out.frames();
    assert_eq!(frames[1]["event"], crate::events::HANDOFF_PROGRESS);
    assert_eq!(frames[1]["id"], 7);
    assert_eq!(frames[2]["payload"]["step"], "two");
    assert_eq!(frames[3]["ok"], "done");
}

#[test]
fn a_bad_line_is_reported_and_the_loop_continues() {
    let out = drive(
        "not json\n\n{\"id\":3,\"cmd\":\"ok\"}\n",
        |_, _| async move { Ok(json!(true)) },
    );
    let frames = out.frames();
    assert!(frames[1]["error"]
        .as_str()
        .unwrap()
        .contains("not a request"));
    assert_eq!(frames[2]["id"], 3);
}

#[test]
fn errors_are_redacted_before_they_are_written() {
    let token = format!("ghp_{}", "b".repeat(36));
    let message = format!("fatal: Authentication failed for 'https://{token}@github.com/o/r.git'");
    let out = drive("{\"id\":1,\"cmd\":\"push\"}\n", move |_, _| {
        let message = message.clone();
        async move { Err(CommandError::internal(message)) }
    });
    let raw = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
    assert!(!raw.contains(&token), "{raw}");
    assert!(out.frames()[1].get("err").is_some());
}

#[test]
fn large_frames_are_compressed_and_round_trip() {
    let big = "x".repeat(COMPRESS_ABOVE * 3);
    let expected = big.clone();
    let out = drive("{\"id\":1,\"cmd\":\"big\"}\n", move |_, _| {
        let big = big.clone();
        async move { Ok(json!(big)) }
    });
    let lines = out.lines();
    assert!(
        lines[1].starts_with(b"{\"z\":"),
        "large frame is compressed"
    );
    assert!(
        lines[1].len() < COMPRESS_ABOVE,
        "and smaller than the threshold"
    );
    assert_eq!(protocol::decode(&lines[1]).unwrap()["ok"], json!(expected));
    // Small frames stay plain JSON.
    assert!(lines[0].starts_with(b"{\"hello\""));
}

#[test]
fn the_real_dispatch_answers_through_the_loop() {
    let missing = std::env::temp_dir().join("gitlane-agent-serve-no-such-repo");
    let input = format!(
        "{}\n",
        json!({ "id": 1, "cmd": "open_repo", "args": { "path": missing } })
    );
    let out = drive(&input, |req, progress| async move {
        dispatch(&req.cmd, &req.args, progress).await
    });
    let frames = out.frames();
    assert_eq!(frames[1]["id"], 1);
    assert_eq!(frames[1]["err"]["kind"], "missingPath", "{frames:?}");
}

#[test]
fn a_compressed_request_is_read_like_a_plain_one() {
    let content = "y".repeat(COMPRESS_ABOVE * 2);
    let line = protocol::encode(&json!({ "id": 9, "cmd": "echo", "args": { "content": content } }));
    assert!(line.starts_with(b"{\"z\":"));
    let input = String::from_utf8(line).unwrap();
    let out = drive(&input, |req, _| async move {
        Ok(json!(req.args["content"].as_str().unwrap().len()))
    });
    assert_eq!(out.frames()[1]["ok"], COMPRESS_ABOVE * 2);
}

#[test]
fn the_loop_ends_when_input_does_even_while_a_watch_holds_a_sender() {
    // A watch keeps its progress sink (and so a frame sender) for good.
    let kept: Arc<Mutex<Vec<Progress>>> = Arc::default();
    let keep = kept.clone();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = drive(
            "{\"id\":1,\"cmd\":\"watch_repo\",\"args\":{}}\n",
            move |_, progress| {
                keep.lock().unwrap().push(progress);
                async { Ok(Value::Null) }
            },
        );
        let _ = done_tx.send(out.frames().len());
    });
    let frames = done_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("serve returned after its input ended");
    assert_eq!(frames, 2, "hello and the watch's reply");
    assert_eq!(kept.lock().unwrap().len(), 1);
}

#[test]
fn a_panicking_command_and_a_malformed_request_still_get_answers() {
    let out = drive(
        "{\"id\":1,\"cmd\":\"boom\",\"args\":{}}\n{\"id\":2,\"cmd\":7}\n",
        |req, _| async move {
            if req.cmd == "boom" {
                panic!("boom");
            }
            Ok(Value::Null)
        },
    );
    let frames = out.frames();
    let err_ids: Vec<u64> = frames
        .iter()
        .filter(|f| f.get("err").is_some())
        .filter_map(|f| f["id"].as_u64())
        .collect();
    assert!(err_ids.contains(&1) && err_ids.contains(&2), "{frames:?}");
}
