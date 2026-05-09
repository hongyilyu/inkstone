# 0013 — `agent_messages` is a separate table from `messages`

Display bubbles live in `messages` (with `parts` fanout for body content) and the raw pi-agent-core `AgentMessage` stream lives in a separate `agent_messages` table as JSON blobs, joined by an optional `display_message_id` FK from `agent_messages` back to `messages` (nullable because tool-result, user, and custom messages exist in pi-agent-core's stream but produce no display bubble).

Three independent reasons drove the split:

1. **Schema asymmetry.** Tool-result/user/custom messages have no `agentName`, `modelName`, `duration`, `error`, or `interrupted` — those columns would be NULL on every row that isn't a display bubble. A single table makes the schema lie about what each row carries.
2. **Shape ownership.** `AgentMessage` is pi-agent-core's contract, not Inkstone's, and evolves on pi's schedule; storing it as an opaque JSON blob lets pi-agent-core widen the type without forcing schema migrations on Inkstone.
3. **Resume cost.** `SELECT data FROM agent_messages WHERE session_id = ? ORDER BY id` → assign to `Agent.state.messages` is one query and zero reconstruction; merging the tables would force resume to filter display-shaped rows and reconstruct the `AgentMessage` shape from a mix of typed columns plus a raw blob.

The JSON column carries Drizzle's `$type<AgentMessage>()` brand for compile-time inference at call sites, but the column itself is plain TEXT with **no runtime validation** — a future pi-agent-core version that widens `AgentMessage` incompatibly will type-check fine on old rows but fail at consumer sites; mitigation is pinning pi-agent-core versions and adding Zod at the boundary if a runtime guarantee ever becomes necessary.

The two tables use independent UUIDv7 minting (each id created at its own call site — `messages.id` at `message_start`, `agent_messages.id` at `message_end`), so cross-table id interleaving is **unsupported** and may sort inconsistently; correlate via the `display_message_id` FK, never by id ordering.
