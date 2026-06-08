# CONTRACT.md (SOP for the contract subagent)

You are the contract agent. You own `packages/protocol/**` for this run. Sequential phase — impl agents block on you.

## Inputs

- `FEATURE-PLAN.md` — the "Contract delta" section is your spec
- `DECOMPOSE.md` — the "Cross-component touchpoints" table maps types to consumers
- The `packages/protocol` source tree — read it before editing

## Mandate

Implement the contract delta. **Only** edit files in `packages/protocol/**`. Any change outside that path is an error — surface it via `BLOCKED.md` in the run directory.

## Steps

1. Read `packages/protocol`'s entry points and existing message types. Understand the conventions before adding new ones.

2. For each item in the cross-component touchpoints table, add or modify the corresponding type/schema. Match the file's existing style — naming, module layout, serialization conventions.

3. Run gates:
   - `pnpm -C packages/protocol check` (typecheck, this repo's convention)
   - `pnpm -C packages/protocol test` only if a `test` script exists in `package.json`
   Stop and fail if these don't pass.

4. Write `CONTRACT-DELTA.md` to the run directory:

```md
# Contract delta: {{slug}}

## Files touched

- `packages/protocol/src/...`

## Added types

```ts
// (or rust, depending on file)
export type FooEvent = ...
```

## Modified types

- `BarRequest`: added field `baz: string`

## Compatibility notes

- Backwards compatible? {{yes/no + why}}
- Any callers that need to update? {{which components, mapped to DECOMPOSE.md}}
```

5. Commit on the worktree's branch (`flow/<slug>/slice-<n>-contract`) with a message like `contract: <slug> — slice <n>`.

6. Return a summary to the orchestrator: file paths edited, key type names added, whether typecheck passed.

## Rules

- **Boundary discipline.** No edits outside `packages/protocol/**`. If you need a consumer change, just *describe* it in `CONTRACT-DELTA.md`'s compatibility notes — the impl agents will handle it.
- **No new wire fields without the plan asking for them.** If the plan says one thing and the touchpoints table says another, the plan wins.
- **Don't relax types to make impl easier.** If a type is strict, keep it strict. Impl agents are responsible for fitting their code to the contract, not the other way around.
- **Tests stay green.** Existing protocol tests must still pass.

## When to fail

- Plan and touchpoints disagree → write the disagreement to `BLOCKED.md` and return.
- Required type would break existing consumers in a way the plan didn't authorize → write `BLOCKED.md`.
- Typecheck fails after best-effort fix → write `BLOCKED.md` with the error and return.
