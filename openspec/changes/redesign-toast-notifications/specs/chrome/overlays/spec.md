## ADDED Requirements

### Requirement: Toast status is shown by a corner glow and icon

A toast MUST show its status through its status icon and a soft glow in the status colour that starts at the card's top-left corner and fades into the normal card surface. A toast MUST NOT show a coloured strip along its left edge or a countdown bar along its bottom edge. This MUST hold in both the dark and light themes. A progress toast MUST keep its progress track.

#### Scenario: An error toast appears

- **WHEN** an error toast is shown
- **THEN** the card has an error-coloured glow from its top-left corner and the error icon
- **AND** it has no left-edge strip and no bottom countdown bar

#### Scenario: A progress toast appears

- **WHEN** a progress toast is shown
- **THEN** it keeps its progress track and has no left-edge strip

### Requirement: A toast stands out from the window behind it

Every toast MUST be visibly separated from the app surface behind it, in both themes, by a thin neutral border and a shadow. The border MUST NOT take the status colour.

#### Scenario: A toast over the main window

- **WHEN** a toast is shown over the app's background in the dark or light theme
- **THEN** the card's edge is clearly visible against that background

### Requirement: The status icon doubles as the close control

A toast's status icon MUST sit at the card's right edge, and a closable toast MUST NOT reserve separate space for a close button. The status icon MUST act as the close control, showing a close symbol while the pointer is over the card or the control has keyboard focus. An in-flight progress toast MUST NOT offer a close control.

#### Scenario: Hovering a toast

- **WHEN** the pointer moves over a closable toast
- **THEN** its status icon is replaced by a close symbol, and clicking it closes the toast

#### Scenario: Keyboard use

- **WHEN** keyboard focus reaches a toast's close control
- **THEN** the close symbol shows with a focus ring, and activating it closes the toast

#### Scenario: A progress toast is hovered

- **WHEN** the pointer moves over an in-flight progress toast
- **THEN** its icon stays and the toast cannot be closed from it

### Requirement: Toasts close on their own after a window set by their content

A toast with no explicit duration MUST close on its own after 5 seconds for info, success and neutral; 8 seconds for a warning; 10 seconds when it is not an error and has an action; and 12 seconds for an error, with or without an action. An in-flight progress toast MUST stay until its operation resolves it. A duration set explicitly for a toast MUST take precedence over these windows.

#### Scenario: A plain success toast

- **WHEN** a success toast with no action is shown and the pointer stays away
- **THEN** it closes after 5 seconds

#### Scenario: A warning toast

- **WHEN** a warning toast with no action is shown and the pointer stays away
- **THEN** it is still open just before 8 seconds and closes at 8 seconds

#### Scenario: A toast with an action

- **WHEN** a non-error toast with an action and no explicit duration is shown and the pointer stays away
- **THEN** it closes after 10 seconds without the action running

#### Scenario: An error toast

- **WHEN** an error toast is shown and the pointer stays away
- **THEN** it closes after 12 seconds, whether or not it has an action

#### Scenario: An operation is still running

- **WHEN** a progress toast has been shown for longer than every window above
- **THEN** it stays open until its operation resolves it

#### Scenario: A caller sets its own duration

- **WHEN** a toast is shown with an explicit duration
- **THEN** it closes after that duration and not after the default for its kind

### Requirement: Hovering the toast stack holds its countdowns

While the pointer is over a toast, every toast countdown MUST pause, and each MUST continue with its remaining time when the pointer leaves. The hold MUST end when the last toast closes, so that closing the last toast under the pointer never prevents later toasts from closing on their own.

#### Scenario: Reading a toast before it closes

- **WHEN** the pointer rests on a toast past the end of its window and then leaves
- **THEN** the toast stays open while hovered and closes after its remaining time

#### Scenario: The last toast is closed under the pointer

- **WHEN** the pointer is over the only toast, the user closes it, and a new toast is shown later
- **THEN** the new toast closes after its own window without being hovered or clicked

### Requirement: A closing toast leaves smoothly

When a toast closes, by its timer, its close button, its action or its operation finishing, the card MUST fade out while moving towards the left edge, and the remaining cards MUST move into the freed space smoothly rather than jumping. A closing card MUST NOT respond to clicks or be announced to assistive technology. When the user has asked for reduced motion, the toast MUST close without this animation.

#### Scenario: The user closes a toast in the middle of the stack

- **WHEN** the user clicks the close button of a toast with cards above and below it
- **THEN** that card fades out to the left in its own position and the stack closes the gap smoothly

#### Scenario: A closing card is clicked

- **WHEN** the user clicks an action on a card that is already closing
- **THEN** the action does not run

#### Scenario: Reduced motion

- **WHEN** the operating system's reduced-motion preference is on and a toast closes
- **THEN** the card and the gap disappear without a sliding or fading transition
