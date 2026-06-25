# Workflow and tool definitions: data in Core, generic Worker

> **As-built amendment (real-worker-codex feature, see [ADR-0023](./0023-provider-oauth-core-owned-credentials.md)).** When the generic interpreter replaced the echo Worker, the spawn manifest was extended beyond this ADR's original sketch in two backward-compatible ways:
> - **Assembled conversation history.** The manifest carries an ordered `messages[]` array — the Thread's completed Messages that Core assembles from tier 2 — so a Run is multi-turn. The Worker maps these to `pi-agent-core` `AgentMessage[]`. (The original ADR implied only the current prompt; history was always going to be needed and is additive.)
> - **An optional provider access token.** For OAuth providers (`openai-codex`), Core injects a short-lived `access_token` into the manifest, resolved per-spawn per ADR-0023. Non-OAuth providers (e.g. the `faux` test provider) omit it.
> - **Deferred fields.** `auto_approve` and `bootstrap` are not yet emitted — they wait for the tools slice. `tools = []` ships today.

A **Workflow** is a TOML file in `crates/core/workflows/`. It is pure declarative data — name, version, system prompt, tool allowlist, model + provider, auto-approve rules, and an optional bootstrap tool-call list. Workflows are owned by Core; the Worker has no per-Workflow code.

A **tool** is implemented in Rust in Core, with its input schema derived from a Rust struct via `schemars`. At Worker spawn, Core ships the tool descriptors (filtered by the Workflow's allowlist) inside the manifest. The Worker constructs `pi-agent-core` `AgentTool` proxies whose `execute` method round-trips back to Core over stdio. Tool implementations exist exactly once, in Rust; the Worker has zero per-tool code.

## Why Workflow as data, not code

A Workflow body has no real procedural content for slice 1:

- **System prompt** — a string.
- **Tool allowlist** — a list of strings (names registered with Core).
- **Model + provider** — two strings the Worker passes to its provider-routing layer.
- **Auto-approve rules** — a list of (tool, condition) consulted by Core's policy function (per [ADR-0016](./0016-proposal-application-policy.md)).
- **Bootstrap context** — a list of tool calls run at Run start, results spliced into the system prompt. Same shape as any other tool call.
- **Conversation loop** — generic across all Workflows: send messages to LLM, handle tool calls, terminate when no more tool calls. Worker infrastructure, not per-Workflow code.

Earlier drafts assumed the Workflow body was TypeScript because the Worker process is TypeScript (per [ADR-0001](./0001-core-worker-split.md)). That conflated process language with definition language. The Worker is TS because the LLM SDK ecosystem (`pi-ai`, `pi-agent-core`) is first-class in TS. Nothing in a Workflow body needs TS execution; the Worker can interpret a TOML manifest.

Adding a Workflow becomes "add one TOML file in `crates/core/workflows/`" — no TS change, no build step, no language-crossing.

## Workflow file shape

```toml
# crates/core/workflows/default.toml

name     = "default"
version  = "1.0.0"
provider = "anthropic"
model    = "claude-sonnet-4-6"

system_prompt = """
You assist with interstitial journaling. The user types loose entries;
you spot Persons, Todos, and Projects worth tracking and propose them
for review.
"""

tools = [
  "search_entities",
  "propose_create_entities",
]

auto_approve = []  # empty per ADR-0016 in slice 1

[[bootstrap]]
tool   = "recent_thread_summary"
params = { limit = 5 }
```

Core deserializes via a Rust struct + `serde`. Bad TOML fails at startup with line/column.

## Worker is a generic interpreter

`packages/worker/src/main.ts` is the only entry point. On spawn:

1. Read manifest from stdin (Core sent it).
2. Initialize the LLM SDK by `manifest.provider`.
3. Build proxy `AgentTool`s from `manifest.tools` (see *Tools* below).
4. Execute `manifest.bootstrap[]` tool calls; splice results into the system prompt.
5. Hand `{ systemPrompt, model, tools, messages }` to `pi-agent-core`'s loop.
6. Relay tool requests / results across stdio while the loop runs.
7. Exit when the loop terminates (or when Core signals abort per [ADR-0013](./0013-worker-process-lifecycle-and-transport.md)).

There is no per-Workflow file in the Worker. Adding a Workflow does not touch Worker code.

## Tools

### Reality of `pi-agent-core`'s tool interface

```ts
// pi-ai/dist/types.d.ts
import type { TSchema } from "typebox";

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;       // TypeBox schema; structurally a JSON Schema
}

// pi-agent-core/dist/types.d.ts
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any>
    extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  executionMode?: ToolExecutionMode;
}
```

Two facts that constrain the design:

- `parameters: TSchema`. TypeBox's `TSchema` is structurally identical to JSON Schema; the wrapper is a TS-only brand. Worker can wrap any JSON Schema object via `Type.Unsafe(jsonSchema)` to satisfy the type system.
- `execute` is a JavaScript function called in-process by `pi-agent-core`'s loop. It does not relay across a process boundary on our behalf.

The earlier "Worker is a dumb stdio relay" framing was incompatible with this — `pi-agent-core` calls `execute` synchronously when the model picks a tool. The Worker must own a JS function for each tool, but that function can be a thin proxy.

### Proxy-to-Core

Tools are implemented in Rust. Each tool has:

- An `Input` struct with `#[derive(Deserialize, JsonSchema)]`.
- An async `execute(input) -> Result<Output>` function.
- `name`, `description`, `label` constants.

At Core boot, a tool registry indexes every registered tool by name. At Run dispatch, Core builds the tool descriptor list filtered by the Workflow's allowlist:

```rust
struct CoreToolDescriptor {
    name: String,
    description: String,
    label: String,
    json_schema: serde_json::Value,  // schema_for!(Input).to_value()
}
```

The descriptor list ships inside the manifest at spawn.

In the Worker:

```ts
function makeProxyTool(
  desc: CoreToolDescriptor,
  callCore: (toolCallId: string, name: string, params: unknown, signal?: AbortSignal) => Promise<CoreToolResponse>,
): AgentTool {
  return {
    name: desc.name,
    description: desc.description,
    label: desc.label,
    parameters: Type.Unsafe<unknown>(desc.jsonSchema) as TSchema,
    async execute(toolCallId, params, signal) {
      const response = await callCore(toolCallId, desc.name, params, signal);
      if (response.kind === "err") {
        // pi-agent-core signals tool errors by THROWING from execute,
        // not by returning a flagged result. The loop catches and emits
        // an error tool_result message.
        throw new ToolExecutionError(response.code, response.message);
      }
      return response.result;  // { content, details?, terminate? }
    },
  };
}

const tools = manifest.tools.map((d) => makeProxyTool(d, callCore));
```

`pi-agent-core` runs its loop with these tools. When the model picks `search_entities`, `pi-agent-core` calls the proxy's `execute`; the proxy sends a `tool_request` over stdio; Core deserializes the params against the authoritative Rust `Input` struct, executes the impl, and returns one of two response shapes; the proxy either resolves with the success result or throws a `ToolExecutionError`; `pi-agent-core` feeds the outcome back to the model.

### Wire frames between Worker and Core

Three frames define the tool-call boundary, all keyed by `tool_call_id` so multiple in-flight calls can be correlated independently:

```jsonc
// Worker → Core
{ "kind": "tool_request",
  "run_id": "...",
  "tool_call_id": "tc_01...",
  "name": "search_entities",
  "params": { "q": "Alice" } }

// Worker → Core (only if pi-agent-core's signal aborts mid-flight)
{ "kind": "tool_abort",
  "run_id": "...",
  "tool_call_id": "tc_01..." }

// Core → Worker (response to tool_request, success or error)
{ "kind": "tool_result",
  "run_id": "...",
  "tool_call_id": "tc_01...",
  "outcome": { "ok":  { "content": [...], "details": {...}, "terminate": false } } }
// or
{ "kind": "tool_result",
  "run_id": "...",
  "tool_call_id": "tc_01...",
  "outcome": { "err": { "code": "tool_execution_failed", "message": "..." } } }
```

`tool_call_id` is the id `pi-agent-core` already assigns when the model emits a tool call (`AgentToolCall.id`). The proxy uses it as a request key; Core uses it to correlate the tool impl's task. **Multiple `tool_request` frames may be in flight concurrently** — `pi-agent-core`'s default `executionMode` is `"parallel"` (see `pi-agent-core/dist/types.d.ts`), so two tool calls in one Turn run their `execute` Promises simultaneously. Core's stdio handler must dispatch each `tool_request` to a separate async task and respond out-of-order; correlation by `tool_call_id` preserves correctness.

### Cancellation: `tool_abort` propagates `AbortSignal`

When `pi-agent-core` aborts the Run (user cancellation, terminate-signaled tool result, etc.), the `signal: AbortSignal` parameter passed to `execute` fires. The proxy listens via `signal.addEventListener("abort", ...)` and emits a `tool_abort` frame to Core. Core looks up the in-flight tool task by `tool_call_id`, cancels it (via `tokio::CancellationToken` or equivalent), and replies with a `tool_result` carrying `outcome.err = { code: "aborted", ... }`. The proxy resolves the abort path by throwing `ToolExecutionError("aborted", ...)`, which `pi-agent-core` already handles.

This is the mechanism that distinguishes mid-Run abort (Worker still alive) from Worker tear-down per [ADR-0013](./0013-worker-process-lifecycle-and-transport.md): Worker tear-down handles the between-Turn parking case; `tool_abort` handles the in-Turn cancellation case.

### What's duplicated, what's not

- **Tool implementation:** single source. Rust only.
- **Input schema:** single source. Rust struct with `#[derive(JsonSchema)]`. Worker receives JSON Schema; Worker never authors a schema.
- **Tool metadata** (name, description, label): single source. Lives next to the Rust impl. Shipped to Worker at spawn.
- **Per-tool Worker code:** zero. The proxy factory is generic; iterating over descriptors creates one `AgentTool` per tool with no per-tool logic.
- **`AgentToolResult` shape:** hand-mirrored once in Rust to match `pi-agent-core`'s actual shape `{ content: (TextContent | ImageContent)[], details?, terminate? }` (per `pi-agent-core/dist/types.d.ts`). **There is no `isError` field on the result** — `pi-agent-core` signals tool errors by `execute` *throwing*, and the loop converts the throw into an error `tool_result` content message. The Inkstone wire shape carries `outcome: { ok: AgentToolResult } | { err: { code, message } }` and the Worker proxy throws on `err`. This is the only schema crossing the boundary in two languages and it follows the same rule [ADR-0009](./0009-protocol-strategy.md) applies to the wire protocol: hand-mirror with contract tests in `tests/contract`.

### Argument validation

`pi-agent-core` may pre-validate arguments against the TypeBox-wrapped schema. Core re-validates against the Rust `Input` struct on receipt — Core trusts nothing crossing the boundary. Belt and suspenders; the second check is the authoritative one.

### Tool allowlist enforcement

Core enforces the Workflow's allowlist on every `tool_request`, using its own copy of the manifest. The Worker's tool array (used by the LLM via `pi-agent-core`) is already filtered, so the model shouldn't propose a disallowed tool — but Core checks anyway. ADR-0003's chokepoint stays intact.

## Versioning

`workflow_version` is a manual semver string declared in the TOML's `version` field. The Workflow author bumps it when system prompt, tool set, model, or auto-approve rules change. `runs.workflow_version` (per [ADR-0017](./0017-tier-2-schema-slice-1.md)) snapshots whatever Core had loaded at Run start.

There is no historical-version registry in slice 1. Resume after restart uses whatever Core has currently loaded — same name, same version. If a Workflow is edited mid-Run-park, the resumed Worker uses the new manifest. Whether that's acceptable is a per-Workflow author decision; the schema and protocol don't enforce one or the other.

## JSON Schema dialect

`schemars` v0 emits JSON Schema Draft-07; v1 emits 2020-12. Anthropic's `input_schema` and OpenAI's `parameters` both accept Draft-07-shaped schemas reliably; 2020-12-only constructs (e.g. `$dynamicRef`, `prefixItems`) trip provider implementations. **Slice 1 pins `schemars` v0 (Draft-07).**

A small sanitization pass runs over each emitted schema before shipping to the Worker:

- Inline any `$ref` / `$defs` produced for nested types — Anthropic's tool-input schema doesn't support `$ref`. `schemars` already supports inline-definitions mode; turn it on.
- Drop unsupported `format` keywords (keep `date-time`, `email`, `uri`; strip Rust-specific ones).
- Reject schemas containing top-level union shapes (`oneOf` / `anyOf` at root) — flatten to a discriminated single object instead. The Rust input struct should be shaped to avoid these from the start.

If a Workflow's tool descriptor fails sanitization, Core refuses to start the Run with a clear error. Adding 2020-12 support is a future ADR.

## What this ADR does not decide

- **Hot reload of Workflows.** Slice 1 reloads on Core restart. Adding hot reload is a Core feature, not a manifest-format question.
- **User-authored Workflows.** Slice 1 ships a single hand-written Workflow. If users author Workflows later (e.g. as markdown files with frontmatter, or via a UI builder), the format question reopens. The TOML format chosen here is forward-compatible — a generated TOML from any source is valid.
- **`prepareArguments` support.** `pi-agent-core`'s `AgentTool.prepareArguments` is an optional pre-validation hook that lets a tool coerce raw model output before the schema check. Slice 1 ships no tools that need it; the proxy omits the field. Adding it later means extending the `CoreToolDescriptor` shape with an optional `prepare_arguments` declaration and giving the proxy a way to invoke it (likely a Core-side coercion call before the main `tool_request`, or a Worker-side declarative coercion table). Out of scope until a tool needs it.
- **`onUpdate` / streaming partial tool results.** `pi-agent-core`'s `execute` accepts an `onUpdate(partial)` callback for tools that stream progress. Slice 1 ships no streaming tools (`search_entities` and `propose_create_entities` are atomic). Adding streaming requires a `tool_update { run_id, tool_call_id, partial }` wire frame Core can push between `tool_request` and the final `tool_result`. The proxy would forward each into `onUpdate`. Wire-frame extension is straightforward; deferred until a tool needs it.
- **Tool implementations in TypeScript via `handler: "ts:<module>"`.** All tools in slice 1 are Rust per ADR-0003. The `handler` escape hatch is reserved for tools that genuinely need a TS-only SDK Core can't reach (e.g. a future MCP client, a TS-native vector store SDK without Rust bindings). The criterion: a tool may declare `handler = "ts:<module>"` only if it is **read-only** with respect to durable Workspace state — if it touches SQLite, it must be Rust to preserve [ADR-0003](./0003-worker-via-tool-protocol.md)'s chokepoint. The escape exists; the bar is high; the slice-1 set has no qualifying tools.
- **Multi-stage Workflows or programmatic prompt construction.** Slice 1's Workflows fit "system prompt + tools + bootstrap." When a Workflow needs procedural logic that doesn't fit, two paths are open: (1) extend the data shape (stages array, prompt-template DSL), or (2) add a per-Workflow handler escape — same shape as the tool handler escape, with the same chokepoint criterion. Either is reachable without disturbing the simple-data Workflows.
- **Tool registry mechanism in Rust.** Whether tools are registered via a `#[tool]` proc macro, a trait-implementing struct registered in a `lazy_static`, or an explicit list in `mod.rs`. Code-write detail.
- **Sharing the `AgentToolResult` mirror via `tests/contract` contract tests.** Implementation of [ADR-0009](./0009-protocol-strategy.md)'s discipline; not new policy.
- **Schemars v1 / Draft 2020-12 migration.** Revisit when a tool needs a feature Draft-07 can't express, or when a future LLM provider rejects Draft-07 schemas.

## Considered and rejected

- **(α) Workflow split across two languages.** Manifest in TOML/JSON in Core, body in TS in Worker, joined by a `name` string. Rejected: two sources of truth for one logical thing, drift inevitable, and the body turned out not to need TS code anyway.

- **(β) Workflow as TS module with build-time JSON extraction for Core.** Was the lean before re-examining what's in a Workflow body. Reasonable when the body has TS code; superseded by the data-only realization. β requires a build step and per-Workflow TS modules; α′ requires neither.

- **(γ) Worker ships manifest to Core at spawn.** Worker's first stdio message is the manifest. Rejected: Core can't dispatch (per [ADR-0011](./0011-per-run-workflow-dispatch.md)) before knowing manifests; tool allowlist enforcement requires Core trusting Worker's claim about its own allowlist (regression on [ADR-0003](./0003-worker-via-tool-protocol.md)).

- **(A) Tool impl in TypeScript.** Tools are JS functions in the Worker that touch SQLite directly. Rejected: contradicts [ADR-0003](./0003-worker-via-tool-protocol.md). Read-only TS tools could work in principle but invite a "some tools here, some there" boundary that erodes.

- **(B) Hand-mirror tool schemas in TS.** TypeBox declarations in Worker, matching Rust structs. Rejected: tool surface grows feature-by-feature; mirroring two-language schemas on every change is a permanent tax. `schemars` + `Type.Unsafe` eliminates the mirror without a codegen toolchain.

- **(C) Bypass `pi-agent-core`, write a custom loop.** Worker uses `pi-ai` directly with our own dispatch. Rejected: substantial re-implementation of the bulk of `pi-agent-core` (tool-call dispatch, abort handling, streaming, message bookkeeping). Gives up the pi-sdk-velocity justification [ADR-0001](./0001-core-worker-split.md) leaned on for picking TS.

## Related

- [ADR-0001](./0001-core-worker-split.md) — Core/Worker split. The premise this ADR clarifies: Worker process is TS for LLM SDK reasons; Workflow definition is data, not code.
- [ADR-0003](./0003-worker-via-tool-protocol.md) — Tool Protocol chokepoint. Proxy-to-Core preserves it; tool-impl-in-TS would break it.
- [ADR-0009](./0009-protocol-strategy.md) — Manual mirroring + contract tests. Same discipline applied to the `AgentToolResult` shape, which is the only structural mirror crossing the boundary.
- [ADR-0011](./0011-per-run-workflow-dispatch.md) — Dispatcher seam in Core. This ADR defines what Dispatcher consults: TOML files in `crates/core/workflows/`.
- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — Per-Run ephemeral Worker over stdio. Manifest is sent on stdin at spawn; tool requests round-trip over the same stdio.
- [ADR-0016](./0016-proposal-application-policy.md) — Auto-approve policy. Manifest declares per-Workflow rules; Core's policy function consults them.
- [ADR-0017](./0017-tier-2-schema-slice-1.md) — `runs.workflow_name + workflow_version + provider + model` snapshot. This ADR defines where those values come from at Run start.
