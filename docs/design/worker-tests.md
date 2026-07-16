# worker-tests

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## interpreter.test.ts — "resumes from a tool_result transcript"

ADR-0025: a `mode:"resume"` manifest whose typed-block transcript ends in a `tool_result` drives `runAgentLoopContinue`. The seeded transcript is provider-valid: the assistant `tool_call` precedes its `tool_result`, and ids match. The seeded tool is NOT re-executed on resume.

The test asserts more than presence. The seeded `tool_result` must be paired to a `tool_call` of matching id in a PRECEDING assistant message — the exact ordering+id invariant a real provider enforces (an orphan/reordered `toolResult` is rejected). This guards slice 3's transcript reconstruction.

The faux response factory reads the live context the REAL transform produced, proving the seeded transcript reached the model with NO orphan rejection: the assistant `tool_call` and its `tool_result` both reached the model, and the `tool_result` is paired to a preceding `tool_call` of matching id.

## models-catalog.test.ts — "model catalog drift"

Drift guard (ADR-0024): Core embeds the model catalog as one **vendor-owned** source file (`catalog.json`: a `vendors` array that owns each model by bare `key`, plus a `providers` array where each provider only declares which vendors it *reaches*). Core derives the per-provider catalog from it; this test re-derives the same way and, for each derived model, asserts the id still exists in `pi-ai`'s registry for that provider and its `{reasoning, input}` match `pi-ai` exactly — so a `pi-ai` bump that adds/removes/retypes a shipped model fails CI here, prompting a JSON fix rather than silent drift.

The display **name is intentionally NOT pinned**: it is vendor-owned (authored once) and, for a `prefixed` provider, derived by prepending the vendor label — whereas `pi-ai` names the same model inconsistently across providers (e.g. `"GPT-5.4 mini"` under openai-codex vs `"GPT-5.4 Mini"` under openrouter). There is no cross-provider "consistency" test because the vendor owns a single list — no per-provider copy exists to diverge.

The test drift-checks the same public registry the interpreter resolves at runtime (`builtinModels()` from `@earendil-works/pi-ai/providers/all`).

## cli.guard.test.ts — "production entry guard"

Production-entry guard (ADR-0019 as-built: faux scripting lives in the test-only `faux/faux-worker.ts`, never the shipping path). `cli.ts` is the production Worker entry Core spawns in a real build; it must carry NO test-only faux-provider code. This guard reads `cli.ts` and asserts none of the faux tokens reappear, so the eviction stays complete as later work stacks on it. (`faux/faux-worker.ts` is the legitimate home for these — not scanned here.)
