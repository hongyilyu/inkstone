# e2e-tests design notes

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## tests/e2e/src/spawnCore.ts — faux Workflow `thinking_level` omission

The faux Workflow TOML written per-test deliberately omits `thinking_level`. This mirrors the real `crates/core/workflows/default.toml`, which also omits it and relies on settings resolution (`DEFAULT_EFFORT = "off"`).

The omission is a regression guard: it exercises the resume path's `resolve_effective_workflow` through the real Worker. An unresolved `thinking_level` would serialize as `""`, and the manifest decode would reject it. Keeping the field absent forces the resolution step to supply the effective value.

## tests/e2e/src/reload-mid-stream.spec.ts — reload mid-stream rehydrates and resumes (Slice 7)

Slice 7 headline acceptance (the wire-web-client criterion previously left manual-smoke only): a Run is owned by Core, not by the socket that started it. So reloading the page mid-stream and reopening the thread rehydrates the partial assistant text and resumes the live stream to completion.

Flow:

- `send "hello"` → assistant bubble shows the partial `"echo: "`
- `page.reload()` → focus is lost (no thread routing); the thread is still listed in the sidebar
- `openThread("hello")` → `thread/get` rehydrates the partial and resubscribes
- `core.tripGate()` → the gated tail streams in → `"echo: hello"`, done

## tests/e2e/src/background-stream.spec.ts — background Run keeps streaming while another thread is focused (Slice 8)

Slice 8 acceptance: a Run is observable independent of which thread is focused, so it keeps streaming in the background while the user is elsewhere.

Flow:

- `send "hello"` → thread A starts a Run; partial `"echo: "` shows
- `newChat()` → focus clears; A's bubble leaves the viewport
- `core.tripGate()` → A's gated tail streams while A is OFF-screen
- `openThread("hello")` → A shows the FULL `"echo: hello"` — it advanced while away

The background Run's stream fiber is keyed by run id and survives the focus change (it is not torn down when the focused thread changes), so the store for A keeps accumulating; reopening A just renders the already-complete text.
