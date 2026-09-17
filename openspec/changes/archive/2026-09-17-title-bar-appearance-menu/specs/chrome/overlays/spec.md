# Spec Delta

## Purpose

Defines the transient overlays that live in the window chrome outside any repository view — starting with the title-bar appearance menu that lets the user pick how the app is themed.

## ADDED Requirements

### Requirement: Title-bar appearance menu offers all three theme preferences

The title bar SHALL expose an appearance control that opens a menu listing exactly three options: **Auto** (follow the operating system), **Light**, and **Dark**. Choosing an option SHALL set the app's theme preference to that value, apply it immediately, and close the menu. The option matching the current preference SHALL be visibly marked as selected.

#### Scenario: Selecting Auto from an explicit theme

- **WHEN** the preference is Dark and the user opens the appearance menu and chooses Auto
- **THEN** the preference becomes Auto, the app paints according to the OS colour scheme, and the menu closes

#### Scenario: Selecting an explicit theme

- **WHEN** the user opens the appearance menu and chooses Light
- **THEN** the app paints light regardless of the OS colour scheme, the preference persists across restarts, and the menu closes

#### Scenario: Current preference is marked

- **WHEN** the preference is Auto and the user opens the appearance menu
- **THEN** the Auto option is marked selected and Light and Dark are not

### Requirement: Appearance trigger reflects the stored preference

The title-bar trigger SHALL show which preference is stored — a distinct "auto" glyph for Auto, a sun for Light, a moon for Dark — rather than the resolved paint mode. Opening the menu SHALL never change the preference by itself.

#### Scenario: Auto on a dark OS

- **WHEN** the preference is Auto and the OS colour scheme is dark
- **THEN** the app paints dark and the trigger shows the auto glyph, not the moon

#### Scenario: Opening and dismissing changes nothing

- **WHEN** the user opens the appearance menu and then clicks outside it or presses Escape
- **THEN** the menu closes and the preference is exactly what it was before

### Requirement: Appearance menu and Settings stay in sync

The title-bar appearance menu and the Settings → General Appearance control SHALL read and write the same preference, so a choice made in either place is reflected in the other without reload.

#### Scenario: Change in Settings shows in the title bar

- **WHEN** the user sets Appearance to Auto in Settings → General
- **THEN** the title-bar trigger shows the auto glyph and the menu marks Auto selected
