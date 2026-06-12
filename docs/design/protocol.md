# Protocol design rationale

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## packages/protocol/src/index.ts — RunEvent (tool_call variant)

Live tool-call boundary (ADR-0006): Core synthesizes these when it receives a
`tool_request` from the Worker and publishes them on the Run Event hub so the
Client can show a tool running. `started` precedes dispatch; the terminal
`completed`/`error` mirrors the outcome. Ephemeral (not persisted), so not
replayed on a snapshot/reconnect (ADR-0022).

## packages/protocol/src/index.ts — proposal/* channel

proposal/* (ADR-0025): a Proposal is a Tool Request awaiting a human Decision.
When the Worker emits a `propose_workspace_mutation` tool_request, Core parks
the Run and persists a pending Proposal. The Proposal lifecycle rides this
`proposal/*` channel, NOT a RunEvent variant.

## packages/protocol/src/index.ts — tool protocol

tool protocol (ADR-0018): the Worker<->Core duplex for tool calls. The Worker
emits `tool_request` on its outbound stream (alongside RunEvents); Core replies
with `tool_result` on the post-manifest inbound stream. `params` and
`json_schema` are opaque JSON forwarded verbatim (the Worker wraps `json_schema`
in `Type.Unsafe`; Core re-validates `params`). The descriptor list ships in the
WorkflowManifest.

## packages/protocol/src/index.ts — WorkerOutbound

What the Worker writes to stdout. NOTE: the `tool_call` and `cancelled` members
of `RunEvent` are Core-synthesized; the Worker never emits them, so Core's
stdout decoder ignores those kinds. The union is widened only because it reuses
`RunEvent`.

## packages/protocol/src/index.ts — WorkerManifest (manifest overview)

Worker manifest (ADR-0018 as-built): the spawn payload Core ships to the generic
interpreter on stdin. Carries the Workflow definition, the assembled
conversation history, and — for OAuth providers — a short-lived access token
(ADR-0023). `tools` is empty until the tools slice.

The full spawn manifest written to the Worker's stdin. `prompt` is the current
user turn; `messages` is the prior completed history (oldest first, excluding
the current prompt). `access_token` is present only for OAuth providers
(ADR-0023); absent for the `faux` test provider and any env-key provider. `mode`
selects the loop entry point (ADR-0025): `fresh` (default/absent) starts a new
prompt; `resume` continues a reconstructed transcript whose last message is a
`tool_result` (via `runAgentLoopContinue`).

## packages/protocol/src/index.ts — ManifestMessage

One prior message in the assembled Thread history (ADR-0018 messages[]), now a
tagged union (ADR-0025). The fresh path emits `user{text}` and `assistant{text}`
exactly as before; the resume path (slice 3 produces it) adds
`assistant.tool_calls` and `tool_result` blocks so the reconstructed transcript
is provider-valid (an assistant `tool_call` precedes its `tool_result`). This is
a backward-compatible superset.
