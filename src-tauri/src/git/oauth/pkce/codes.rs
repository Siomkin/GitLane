//! PKCE verifier/challenge generation, the CSRF `state` value, and the secure
//! randomness they draw on.

use base64::Engine;
use sha2::{Digest, Sha256};

const B64URL: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// A PKCE verifier/challenge pair (RFC 7636). The verifier is secret; the
/// challenge is safe to put in the authorize URL.
#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// Generate a fresh PKCE pair: a 43+ char base64url verifier from 64 random
/// bytes, and its S256 challenge.
pub fn generate_pkce() -> Result<Pkce, String> {
    let verifier = B64URL.encode(random_bytes::<64>()?);
    let challenge = code_challenge(&verifier);
    Ok(Pkce {
        verifier,
        challenge,
    })
}

/// A fresh CSRF `state` value (base64url of 32 random bytes).
pub fn generate_state() -> Result<String, String> {
    Ok(B64URL.encode(random_bytes::<32>()?))
}

/// The S256 code challenge for a verifier: `BASE64URL(SHA256(ASCII(verifier)))`.
pub fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    B64URL.encode(digest)
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Could not gather secure randomness for sign-in.".to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_challenge_matches_rfc7636_vector() {
        // RFC 7636 Appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn generated_pkce_is_valid_and_self_consistent() {
        let pkce = generate_pkce().unwrap();
        assert!((43..=128).contains(&pkce.verifier.len()));
        assert_eq!(code_challenge(&pkce.verifier), pkce.challenge);
        // Two calls differ.
        assert_ne!(generate_pkce().unwrap().verifier, pkce.verifier);
    }
}
