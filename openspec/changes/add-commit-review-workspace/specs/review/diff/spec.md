# Spec Delta

## ADDED Requirements

### Requirement: Changed words are highlighted within modified lines

In the single-file review's split and unified diffs, each removed line paired with an added line
SHALL highlight the words that differ between the two, on top of the line's own tint. Lines with
nothing in common, and lines too long to compare, SHALL keep the whole-line tint only.

#### Scenario: One word changed
- **WHEN** a line `line 2` is replaced by `line 2 changed`
- **THEN** the word `changed` is highlighted on the added line and nothing extra on the removed line

#### Scenario: A word replaced
- **WHEN** `return a + b` is replaced by `return a - b`
- **THEN** `+` is highlighted on the removed line and `-` on the added line

#### Scenario: Unrelated replacement
- **WHEN** a line is replaced by a line sharing no words with it
- **THEN** neither line shows word highlights
