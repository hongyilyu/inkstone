# worker-tests

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## interpreter.test.ts — "resumes from a tool_result transcript"

ADR-0025: a `mode:"resume"` manifest whose typed-block transcript ends in a `tool_result` drives `runAgentLoopContinue`. The seeded transcript is provider-valid: the assistant `tool_call` precedes its `tool_result`, and ids match. The seeded tool is NOT re-executed on resume.

The test asserts more than presence. The seeded `tool_result` must be paired to a `tool_call` of matching id in a PRECEDING assistant message — the exact ordering+id invariant a real provider enforces (an orphan/reordered `toolResult` is rejected). This guards slice 3's transcript reconstruction.

The faux response factory reads the live context the REAL transform produced, proving the seeded transcript reached the model with NO orphan rejection: the assistant `tool_call` and its `tool_result` both reached the model, and the `tool_result` is paired to a preceding `tool_call` of matching id.

## models-catalog.test.ts — "model catalog drift"

Drift guard (ADR-0024): Core embeds the `openai-codex` model catalog as a JSON file hand-mirrored from `pi-ai`'s `MODELS`. This test re-derives the catalog from the installed `pi-ai` and asserts the committed JSON matches the retained `ModelInfo` subset (`id`/`name`/`reasoning`/`input` — `cost` was dropped in the feature-cut sweep and is projected away before comparison) — so a `pi-ai` bump that adds/removes/retypes an `openai-codex` model fails CI here, prompting a regenerate of the JSON rather than silent drift.

`pi-ai` does not re-export `MODELS` from its package entry, and its `exports` map blocks the deep `dist/models.generated.js` path via specifier, so the test resolves the package's main entry and imports the sibling generated file by absolute URL (which bypasses the exports gate).

## cli.guard.test.ts — "production entry guard"

Production-entry guard (ADR-0019 as-built: faux scripting lives in the test-only `faux/faux-worker.ts`, never the shipping path). `cli.ts` is the production Worker entry Core spawns in a real build; it must carry NO test-only faux-provider code. This guard reads `cli.ts` and asserts none of the faux tokens reappear, so the eviction stays complete as later work stacks on it. (`faux/faux-worker.ts` is the legitimate home for these — not scanned here.)
