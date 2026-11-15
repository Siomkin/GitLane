# Spec Delta

## ADDED Requirements

### Requirement: Checking that a saved keychain token exists does not read the secret on macOS

On macOS, when GitLane checks whether a GitLane-owned provider token is still in the OS keychain, it MUST NOT read the token's secret, so the check MUST NOT raise a keychain access prompt. GitLane MUST read the secret only when the token is used for git transport or a pull-request operation. The check MUST still report a token that was removed outside GitLane as missing.

#### Scenario: Launch after an update with saved tokens

- **GIVEN** two provider tokens are saved in the keychain, and GitLane was just updated so macOS has not yet allowed this build to read them
- **WHEN** the user launches GitLane and does nothing else
- **THEN** macOS shows no keychain access prompt, and both accounts still show as signed in

#### Scenario: Opening the Accounts settings

- **GIVEN** a provider token is saved in the keychain and this build has not been allowed to read it
- **WHEN** the user opens Settings → Accounts
- **THEN** macOS shows no keychain access prompt

#### Scenario: Token removed outside GitLane

- **GIVEN** a provider token GitLane saved was deleted in Keychain Access
- **WHEN** GitLane checks its saved tokens
- **THEN** that account is no longer shown as signed in with a keychain token, and macOS shows no prompt

#### Scenario: Using the token still asks

- **GIVEN** a provider token is saved and this build has not been allowed to read it
- **WHEN** the user fetches from a remote that authenticates with that token
- **THEN** macOS asks for access to that token, and the fetch proceeds once the user allows it
