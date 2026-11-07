#[cfg(unix)]
#[test]
fn a_hanging_command_is_killed_at_its_timeout() {
    let mut cmd = std::process::Command::new("sh");
    cmd.args(["-c", "echo partial; sleep 30"]);
    let started = std::time::Instant::now();
    let out = super::output_within(cmd, std::time::Duration::from_millis(300), 1024);
    assert_eq!(out, None);
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

#[cfg(unix)]
#[test]
fn a_command_that_finishes_returns_its_stdout() {
    let mut cmd = std::process::Command::new("sh");
    cmd.args(["-c", "echo ok"]);
    let out = super::output_within(cmd, std::time::Duration::from_secs(5), 1024);
    assert_eq!(out.as_deref(), Some(&b"ok\n"[..]));
}

#[cfg(unix)]
#[test]
fn reap_kills_the_childs_group_and_nothing_outside_it() {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex};

    let mut bystander = Command::new("sleep").arg("30").spawn().unwrap();
    // The grandchild prints its pid, then holds the group open.
    let mut child = Command::new("sh")
        .args(["-c", "sleep 30 & echo $!; wait"])
        .stdout(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(child.stdout.take().unwrap()),
        &mut line,
    )
    .unwrap();
    let grandchild = line.trim().to_string();

    super::reap(&Arc::new(Mutex::new(Some(child))));

    // The grandchild is in the group, so it gets SIGTERM and is gone shortly.
    let gone = (0..50).any(|_| {
        std::thread::sleep(std::time::Duration::from_millis(20));
        !Command::new("kill")
            .args(["-0", &grandchild])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    });
    let bystander_alive = bystander.try_wait().unwrap().is_none();
    let _ = bystander.kill();
    let _ = bystander.wait();
    assert!(gone, "grandchild {grandchild} outlived reap");
    assert!(
        bystander_alive,
        "reap signalled a process outside the group"
    );
}

#[cfg(unix)]
#[test]
fn a_command_that_exits_non_zero_returns_none() {
    let mut cmd = std::process::Command::new("sh");
    cmd.args(["-c", "echo nope; exit 3"]);
    let out = super::output_within(cmd, std::time::Duration::from_secs(5), 1024);
    assert_eq!(out, None);
}

#[cfg(unix)]
#[test]
fn a_slot_is_reaped_once_and_a_second_reap_does_nothing() {
    use std::os::unix::process::CommandExt;
    use std::sync::{Arc, Mutex};

    let child = std::process::Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    let slot = Arc::new(Mutex::new(Some(child)));
    assert!(
        super::reap(&slot).is_some(),
        "the first reap collects the child"
    );
    assert!(slot.lock().unwrap().is_none(), "the slot is emptied");
    assert_eq!(super::reap(&slot), None, "the second reap finds nothing");
}
