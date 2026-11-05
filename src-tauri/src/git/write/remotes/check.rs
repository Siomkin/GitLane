//! Check that a remote accepts the credential a fetch would use, right after
//! the user saves one in Settings: `git ls-remote --quiet <remote> HEAD`, which
//! authenticates like a fetch but prints at most one line.

use super::super::operands::ensure_operand;
use super::transport::run_transport;
use crate::git::transport_auth::TransportCredential;

pub fn check_remote_access(
    repo: &str,
    remote: &str,
    cred: &TransportCredential,
) -> Result<(), String> {
    ensure_operand(remote)?;
    run_transport(repo, cred, &["ls-remote", "--quiet", remote, "HEAD"]).map(|_| ())
}
