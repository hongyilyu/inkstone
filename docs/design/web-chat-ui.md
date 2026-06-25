# web-chat-ui design rationale

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## ChatCardRecess.tsx — chatCardPath

Builds a CSS clip-path that carves a smooth recess out of the chat card's top
edge for the TopRightControls icon cluster. The recess is a "bay": the chat
card's top edge dips down with a single smooth concave arc on the left, then
runs flat to the right, where the top-right corner rounds off into the right
edge that meets the activity rail.

`chatCardPath` returns the raw SVG path data; callers wrap it in `path("…")`
inline to apply it as a CSS clip-path:

```tsx
el.style.clipPath = `path("${chatCardPath(w, h, { bay: hasRail })}")`;
```

Trace clockwise from the
top-left corner's start, around the perimeter of the visible card shape. With
`bay: false` the top edge stays flat with both corners rounded — the plain
framed surface a page uses when it has no right rail (and so no floating control
to carve a recess for).

The bay's left shoulder is a cubic Bezier S-curve from `(recessLeft, 0)` to
`(recessLeft + ARC, RECESS_DEPTH)` with both control points at the curve's
horizontal midpoint, so the tangent is horizontal at BOTH ends: flush with the
flat top, flush with the flat floor.

## ChatColumn.tsx — ChatColumn

Empty-state branching (a focused, message-less thread keys off the reactive
`useHydrationStatus`, issue #108): no thread focused → fresh chat (welcome the
user and teach the loop); focused + `loading`/never-hydrated → skeleton; focused
+ `error` → a recoverable error state with a "Try again" that re-runs
`hydrateThread`, NEVER an eternal skeleton — PRODUCT.md "show the state, not a
spinner".

Hydration: on focus change to a non-null thread with `undefined` (never-hydrated)
status we run thread/get → load → resubscribe-if-streaming. Locally-originated
threads are pre-marked `ready` (in `bridge.ts`) so this is a no-op for them (no
double-load / double-resubscribe). A settled `error` is not auto-retried — only
the user's "Try again" re-fires it.

Proposal stream: consume the global `proposal/*` stream once for the chat
surface. A parked Run pushes `proposal/pending` → the bridge fetches + attaches
the Proposal, which the assistant turn's review card reads (ADR-0025).
Idempotent.

Retry: re-issue a previous user turn after a failed/interrupted Run. The thread
already exists (it holds the failed turn), so this always takes the `send` path,
mirroring the composer's send (surface errors + bump the sidebar's last-activity
order).

Compose send: send into the focused thread, or mint a new one on the first
message. Either way, refresh the sidebar's thread/list read so a freshly-created
thread (or a bumped last-activity order) shows without a manual reload — the
precondition for switching threads.

## ToolActivity.tsx — ToolPresentation

`active` is the present-tense label shown while the tool runs ("Reading
thread"); `done` is the settled past-tense label. `access` records what the tool
is allowed to touch: `read` tools only observe durable state (writes never run
live — they surface as a reviewable Proposal, the "approval is sacred"
contract), so the row says so. Unknown tools fall back to a humanized name + a
generic glyph and make NO access claim, so a newly-registered Core tool still
renders sensibly (and honestly) before it gets an entry here.

## ToolActivity.tsx — ToolActivity

Live tool-call activity within an assistant turn (ADR-0006 tool_call Run
Events). Renders one compact row per call. The running row carries the signature
lamplight glow on its glyph; completed rows settle to a quiet check; an errored
row pairs an alert glyph with "failed". Read-only tools say so, so the user can
see the agent only observed. State is conveyed by icon + label + a screen-reader
status, never colour alone, and all motion is gated behind `motion-safe`
(DESIGN.md).

## ProposalCard.tsx — lastAttempt

The last decision attempted, retained across the `deciding → error` transition
(unlike `inFlight`, which clears) so "Try again" re-issues the SAME decision.
Without this, a failed Dismiss/Save retried as a hardwired `accept` would create
the Journal Entry the user rejected — and an edit retried as accept would
silently revert the user's edits.

## ProposalCard.tsx — retry disabled gate

Gate the retry on what it will actually re-send. A reject never depends on
payload validity; a stored edit carries a payload already validated at save
time; only a plain accept (or no prior attempt) falls back to the original
payload's `canApply`.

## AssistantProposals.tsx — AssistantProposals

Render the live pending Proposal (if any) for an assistant turn's Run. The
Proposal is keyed by `runId` in the chat store (a parked Run pushes a
`proposal/pending` notification → the bridge attaches it). Deciding routes
through `decideProposal`, which calls `proposal/decide` and resumes the Run.
Renders nothing until a Proposal is attached.

On an accept/edit (which creates an Entity in Core) we invalidate the
`["library-items"]` query so the Library reflects the new Journal Entry without
a manual reload. A reject creates nothing, so it is not invalidated.
