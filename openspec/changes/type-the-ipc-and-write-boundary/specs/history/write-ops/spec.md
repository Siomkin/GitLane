# Spec Delta

## ADDED Requirements

### Requirement: The reset preview describes only a reset that can run

The reset confirmation SHALL be built from the same mode parsing as the reset write. An unknown mode MUST be refused at preview time. It MUST NOT be previewed as a different mode.

#### Scenario: Unknown reset mode
- **WHEN** a reset preview is requested with mode `"keep"`
- **THEN** the preview fails with a validation error and no "Reset mixed" confirmation is shown
