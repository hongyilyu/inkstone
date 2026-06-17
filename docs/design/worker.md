# worker

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## interpreter.ts — runInterpreter / module

The generic interpreter (ADR-0018): a single, Workflow-agnostic loop that turns a `WorkerManifest` into a streamed conversation against a real provider via `pi-agent-core`. There is NO per-Workflow code here — the manifest is pure data.

This module is provider-agnostic and dependency-injected so it can be driven offline by `pi-ai`'s `faux` provider in tests (ADR-0019 as-built): the caller supplies how to resolve a `Model` from the manifest and the `streamFn` that issues the LLM call. Production wiring (real `getModel` + token-injecting `streamSimple`) lives in `defaultInterpreterDeps`; tests pass a faux model + plain `streamSimple`.

`runInterpreter` drives one Run to completion. It emits `text_delta` Run Events as the model streams, then exactly one terminal event: `done` on clean completion or `error` if the model/stream failed (pi surfaces this as an assistant message with `stopReason: "error" | "aborted"`).

Tools (ADR-0018): the Workflow's tool descriptors become `pi-agent-core` proxies whose `execute` round-trips to Core via the transport's `callTool` (the bidirectional Tool Protocol channel, ADR-0006). A manifest with no tools runs chat-only.

Mode (ADR-0025): `manifest.mode === "resume"` continues a reconstructed transcript via `runAgentLoopContinue` — the manifest's `messages` ARE the full transcript (ending in a `tool_result`) and NO new prompt is added, so the seeded tool call is not re-executed. Any other/absent mode is the fresh path: `runAgentLoop([prompt], …)`.

Both transport channels are sourced from the seam (ADR-0027) once at the top: the synchronous `emit` (Run Events) and the request/response `callTool` (Tool Protocol). Both feed pi's callbacks, which run outside the Effect context (ADR-0027 push-shape).

## interpreter.ts — toAgentMessages

Map the manifest's assembled history into pi `Message[]`. Handles the tagged-union `WorkerManifest` message blocks (ADR-0025):
- `user` → a pi `UserMessage` carrying the text.
- `assistant` → a pi `AssistantMessage` whose `content` is the optional text block followed by any `tool_calls` as `toolCall` content blocks (so a resumed transcript carries the prior turn's tool requests).
- `tool_result` → a pi `ToolResultMessage` whose `toolCallId` matches the assistant's `toolCall.id` — the pairing that makes the transcript provider-valid (a `toolResult` is rejected unless its `toolCall` precedes it).

History is oldest-first and, for the fresh path, excludes the current turn (the prompt is appended separately). For the resume path the manifest's `messages` IS the full transcript (ending in a `tool_result`).

## faux/faux-worker.ts — module (TEST-ONLY entry)

TEST-ONLY Worker entry — never the production worker command. Lives under `src/faux/` (with `faux-decisions.ts` and its test), kept out of the top-level `src/` deep core so a reader can tell the Worker from its test mock at a glance.

This file fakes the LLM provider so Core/e2e integration tests can drive the REAL generic interpreter offline and deterministically. It is selected by tests via `INKSTONE_WORKER_CMD` (they spawn `tsx .../faux-worker.ts`); it is never wired into a shipped build. Production uses `cli.ts`. Reading the `INKSTONE_FAUX_*` env vars below is legitimate — this is test code (ADR-0019 as-built: faux scripting lives at a dedicated test-only entry, off the production path).

## faux-worker.ts — fauxDepsFor

Build interpreter deps that script pi-ai's faux provider from the `INKSTONE_FAUX_*` env vars, so Core/e2e tests drive the real interpreter offline. This entry is ALWAYS faux (no `provider` guard — `cli.ts` is the production path): every manifest gets a faux provider whose queued response(s) are env-scripted.

The five modes (first match wins):
- `INKSTONE_FAUX_ERROR` (non-empty) → a single error message.
- `INKSTONE_FAUX_TOOL_CALL === "1"` → turn 1 `read_thread` on the pasted thread id, turn 2 echoes the tool result. Uses response factories so it reads the live context (the pasted id, then the tool result the proxy round-tripped back).
- `INKSTONE_FAUX_PROPOSE === "1"` → `propose_workspace_mutation` (fresh) / short completion (resume), the ADR-0025 park/resume dance. The fresh turn calls the Journal Entry intake tools, which Core round-trips, persists as a pending Proposal, and PARKS (tearing this Worker down). On resume (`mode:"resume"`) Core re-spawns with the reconstructed transcript ending in the Decision tool_result; the loop continues with a short completion. The faux provider state is per-process, so the resume spawn freshly applies the resume response (mirrors propose-worker.ts at the protocol level).
- `INKSTONE_FAUX_ECHO_HISTORY === "1"` → echo the prior turns' roles+text. Replies with the prior messages the loop passed in its context — both roles — so the test can prove Core assembled BOTH the prior user prompt AND the prior assistant reply into the manifest history (the assistant turn is the slice-9 race that this exercises). Uses a response factory so it reads the live context rather than a canned string.
- else → `INKSTONE_FAUX_RESPONSE` (or a default) as a plain assistant reply.

## faux-worker.ts — entry guard

Run only when this file is the process entry (Core/e2e spawn it as `tsx .../faux-worker.ts`), NOT when imported — `faux-worker.test.ts` imports `fauxDepsFor` to unit-test the dep-builder and must not boot a Worker (which would read stdin and `process.exit`). `realpathSync` both sides so the macOS `/var`→`/private/var` symlink doesn't defeat the comparison.

The Provider Helper (`provider.ts`) moved to its own package — see `provider-helper.md` (ADR-0040).

## tool-proxy.ts — module / makeProxyTools / ToolResultOk

Worker-side tool proxies (ADR-0018). Tools are implemented once in Rust (Core); the Worker builds thin `pi-agent-core` `AgentTool` proxies whose `execute` round-trips a `tool_request`/`tool_result` to Core over stdio. There is zero per-tool code here — the factory is generic over the descriptors Core ships in the manifest.

`ToolResultOk` is the `ok` outcome Core sends in a `tool_result`. It mirrors the Rust `AgentToolResult` wire shape: `content` is required; `details`/`terminate` are omitted when absent (Rust `skip_serializing_if`). Distinct from `pi-agent-core`'s `AgentToolResult<T>`, which requires `details`.

`makeProxyTools` builds `AgentTool` proxies from Core's tool descriptors. Each proxy carries the descriptor's metadata and a `json_schema` (TypeBox's `TSchema` is structurally a JSON Schema with a TS-only brand, ADR-0018:102, so the Core-supplied schema satisfies it at runtime). `execute` delegates to `callTool`; on an `err` outcome it THROWS — `pi-agent-core` signals a tool error by `execute` throwing and converts it into an error tool result.

## worker-main.ts — runWorkerMain

The shared Worker entry scaffolding (ADR-0013 stdin transport, ADR-0018 generic interpreter, ADR-0027 transport seam). Both the production entry (`cli.ts`) and the test-only faux entry (`faux-worker.ts`) call this with their own dep-builder; the only difference between the two entries is which `InterpreterDeps` they inject. There is no per-Workflow code here.

`main` is an `Effect.gen` from entry to exit (ADR-0020): it reads the manifest through `WorkerTransport`, runs the generic interpreter against the stdio transport, and lets the interpreter emit Run Events as NDJSON. The stdio plumbing — readline, the `tool_call_id` correlation map, the stdout writer — lives behind the seam in `StdioTransportLive`. The interpreter sources both transport channels (`emit` + `callTool`) from the provided seam (ADR-0027); only provider deps are injected.

This module has NO top-level side effect: `runWorkerMain` does the running only when an entry calls it, so the entries (and their tests) can import the scaffolding without booting a Worker.

A Run never ends without a terminal event: a bad manifest (typed `ManifestParseError`) or an unexpected throw (unknown provider in `getModel`, a loop defect) is converted into a terminal `error` Run Event through the seam (ADR-0006). As a last resort, the seam already emits the terminal error for every non-catastrophic path; a rejection at `runPromise` means stdout itself failed — nothing left to do but exit non-zero.

## cli.ts — production entry

The PRODUCTION Worker entry point (ADR-0013 stdin transport, ADR-0018 generic interpreter, ADR-0027 transport seam). Core spawns this via `INKSTONE_WORKER_CMD` for a real Run. It drives the generic interpreter against real provider deps (`defaultInterpreterDeps`: real `getModel` + token-injecting `streamSimple`); the entry scaffolding — manifest read, the terminal-event guarantee, the stdio transport — lives in `runWorkerMain`.

There is no per-Workflow code and NO test-only faux-provider scripting here: faux scripting lives in the dedicated test-only entry `faux-worker.ts` (ADR-0019 as-built), kept off the shipping path. `cli.guard.test.ts` enforces that this file stays faux-free.
