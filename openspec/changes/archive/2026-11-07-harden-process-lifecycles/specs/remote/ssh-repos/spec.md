## ADDED Requirements

### Requirement: An open ssh question pauses the connect timeout only while it is open

While an ssh question for a connect attempt is shown to the user, the time it stays open MUST NOT count toward that attempt's connect timeout. Once the question closes, the timeout MUST resume, so a connect that then stalls still fails. This holds however the question closes: answered, cancelled, expired, or failed inside GitLane.

#### Scenario: Slow answer
- **GIVEN** a connect attempt whose host asks for a password
- **WHEN** the user takes longer than the connect timeout to answer, and the host then responds
- **THEN** the connect succeeds and is not timed out

#### Scenario: Question fails inside GitLane
- **GIVEN** a connect attempt whose host asks a question
- **WHEN** GitLane fails to show or collect the answer, and the host never completes the connect
- **THEN** the connect still fails after the timeout, and the tab shows the connection error
