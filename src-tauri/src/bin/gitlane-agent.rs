//! The headless git core GitLane uploads to a remote host and drives over SSH
//! (remote-ssh-repos). Built with `--no-default-features --features agent`.

fn main() {
    gitlane_lib::run_agent()
}
