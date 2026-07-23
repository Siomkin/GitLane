//! `operands` write-path tests.

use super::support::*;

#[test]
fn rejects_dash_prefixed_operands() {
    // Option-injection vectors a malicious ref / raw input could carry into git.
    assert!(ensure_operand("--upload-pack=touch /tmp/x").is_err());
    assert!(ensure_operand("--exec=rm -rf /").is_err());
    assert!(ensure_operand("-D").is_err());
}

#[test]
fn allows_legitimate_refs_and_oids() {
    for ok in [
        "main",
        "feature/GP-3-foo",
        "origin/main",
        "2fe77a5abf25",
        "v1.2.3",
    ] {
        assert!(ensure_operand(ok).is_ok(), "{ok} should be allowed");
    }
}
