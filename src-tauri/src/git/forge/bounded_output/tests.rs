//! `bounded_output` tests, split by what they exercise. The fake CLI child
//! itself stays here: it re-enters this binary by the exact test path
//! `git::forge::bounded_output::tests::fake_cli_child`.

mod capture;
mod reader;
mod support;

use std::io::Write;
use std::time::Duration;

use support::{CHILD_MODE, CHILD_SIZE};

#[test]
fn fake_cli_child() {
    let Ok(mode) = std::env::var(CHILD_MODE) else {
        return;
    };
    let size = std::env::var(CHILD_SIZE)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);

    match mode.as_str() {
        "stdout" => write_bytes(std::io::stdout(), b'o', size),
        "stderr" => write_bytes(std::io::stderr(), b'e', size),
        "both" => {
            install_child_watchdog();
            write_bytes(std::io::stdout(), b'o', size);
            write_bytes(std::io::stderr(), b'e', size);
        }
        "overflow-sleep" => {
            install_child_watchdog();
            write_bytes(std::io::stdout(), b'o', size);
            std::thread::sleep(Duration::from_secs(30));
        }
        "exit" => {
            std::io::stdout().write_all(b"stdout").unwrap();
            std::io::stderr().write_all(b"stderr").unwrap();
            std::process::exit(7);
        }
        other => panic!("unknown fake child mode {other}"),
    }
    std::process::exit(0);
}

fn install_child_watchdog() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(8));
        std::process::exit(98);
    });
}

fn write_bytes(mut writer: impl Write, byte: u8, size: usize) {
    let chunk = [byte; 8192];
    let mut remaining = size;
    while remaining > 0 {
        let count = remaining.min(chunk.len());
        writer.write_all(&chunk[..count]).unwrap();
        remaining -= count;
    }
    writer.flush().unwrap();
}
