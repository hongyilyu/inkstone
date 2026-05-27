# Worker reaches Core-owned resources only through the Tool Protocol

The Worker has no direct access to the SQLite database, the Vault, or external services. Every Core-owned action goes through a Tool Request and is satisfied by a Tool Result on the bidirectional Tool Protocol channel.

## Why

Sandbox by construction. The Worker is the component most directly exposed to LLM output — the model decides what the Worker tries to do next. If the Worker held DB or filesystem access, "the Worker can do X" would in practice mean "the LLM can do X" once prompt injection or model misbehavior is considered.

Routing every Core-owned action through `tool_request` / `tool_result` gives Core a single chokepoint where it can:

- Validate the request against the current Workflow's allowed-tools list.
- Enforce per-tool permissions (read-only, requires approval, rate-limited, etc.).
- Audit every action an agent took during a Run.
- Refuse or transform a request without the LLM noticing.

The cost is the protocol overhead and the discipline of writing each capability as a tool. We accept it as the price of containment.

## Scope

This rule applies to **Workspace and external state**, not to Worker-internal scratch state. The Worker may hold in-memory data needed to drive a Run (current Turn context, partial assistant text, tool call bookkeeping). Durable consequences must go through Core.

The Worker keeps direct access to **LLM providers** — that side is owned by the Worker by design (see [ADR-0001](./0001-core-worker-split.md)).

## Consequences

- Every new Worker capability that touches durable state is implemented as a tool in Core, not as Worker-side code.
- The Tool Protocol must be expressive enough to cover the agent's needs (read, query, propose write, request approval); tool surface design is a recurring concern.
- Tool execution is a security boundary, not a convenience layer — Core treats Tool Requests as untrusted input.
