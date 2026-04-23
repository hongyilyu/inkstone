# Inkstone — E2E Testing Plan

## Goal

Add automated regression coverage for the real Inkstone UI behavior without introducing a PTY/server harness the app does not currently need.

## Assumptions

- Inkstone remains an in-process OpenTUI + Solid application.
- The primary regression layer should exercise the mounted app, not a spawned terminal process.
- Backend model/network behavior is out of scope for the first pass and should be mocked in UI tests.

## Chosen Test Strategy

### Primary layer

Use headless OpenTUI app tests with `@opentui/solid` `testRender(() => <App />)`.

This should cover:

- app boot
- keybind-driven UI flows
- dialog visibility and close behavior
- responsive layout changes on resize
- streamed conversation rendering from mocked agent events

### Secondary layer

Use plain Bun tests for backend logic that does not need the renderer:

- persistence helpers
- guard behavior
- model/agent selection logic

### Deferred layer

Do not add PTY/process-level terminal tests unless Inkstone later gains:

- a server boundary
- an embedded shell/terminal feature
- a real detached runtime that differs materially from headless app mounting

## First Features To Test

### 1. App boot

Verify:

- the app mounts successfully
- the empty/open page is visible
- no prompt/dialog state crashes on first render

### 2. Command and dialog flows

Verify:

- global palette/dialog keybinds open the expected UI
- close paths return focus/state to the base screen
- dialog stack behavior does not leave stale UI behind

### 3. Responsive layout

Verify:

- the sidebar is shown at wide widths
- the sidebar hides at narrow widths
- resizing back restores the expected layout

### 4. Streaming transcript rendering

Verify:

- mocked `message_start` / `message_update` / `message_end` events append the right assistant bubble content
- per-message footer metadata renders on the correct bubble
- turn duration is stamped only on the turn-closing assistant bubble

### 5. Session reset and restore edges

Verify:

- clear-session returns the UI to the open state
- persisted session data can be mounted without crashing
- restored transcript state renders as expected

## Execution Order

1. Add a minimal app smoke test -> verify: `bun test` finds and runs at least one mounted OpenTUI test.
2. Add test helpers for isolated config/state directories -> verify: tests do not read or write the user's real Inkstone files.
3. Add dialog and resize tests -> verify: key UI shell behavior is covered before conversation-specific flows.
4. Add mocked streaming transcript tests -> verify: the most important message-rendering path is covered without real provider calls.
5. Add backend unit tests for persistence and guards -> verify: non-UI edge cases are covered without overloading the renderer suite.

## Definition of Done

The first E2E milestone is complete when:

- `bun test` runs a headless OpenTUI suite successfully
- boot, dialog flow, resize behavior, and mocked streaming transcript rendering are covered
- tests run without touching the user's real config/session files
- no PTY/process harness has been added
