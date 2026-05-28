# Effect across the TypeScript codebase

TypeScript modules in Inkstone are written on top of [Effect](https://effect.website). Runtime schemas, IO-bearing functions, service injection, and asynchronous streams use Effect's primitives — `Schema`, `Effect`, `Layer`, `Stream`, `Fiber` — instead of plain async/await + zod + ad-hoc class-based services. React talks to Effect through `@effect/rx` + `@effect-rx/rx-react`.

## Scope

This ADR commits to one rule: **every TypeScript module in `apps/`, `packages/`, and `bridges/` imports `effect`** when it does anything Effect can express idiomatically — runtime validation, IO, service lookup, async streams, typed errors. That includes `packages/protocol`, `packages/ui-sdk`, `packages/worker`, and `apps/web`.

What this rule does *not* commit to:

- **Style.** Whether a five-line array `map` uses `pipe(...)` is a PR-level taste decision, not an architectural one. The ADR doesn't constrain it.
- **Ecosystem.** Adopting `@effect/platform`, `@effect/sql`, `@effect/cluster`, or other ecosystem packages is a future decision per package, not a blanket commitment.
- **Rust.** Core stays on `serde` + `tokio`; this ADR is TypeScript-only. Cross-language consistency is governed by [ADR-0009](./0009-protocol-strategy.md).

## Why

**Tool-fit.** The Inkstone TypeScript surface area is dominated by problems Effect's primitives address directly:

- Run Events arrive as a stream of Notifications routed by `run_id` ([ADR-0014](./0014-client-core-wire-protocol.md)). `Stream` is first-class; routing, backpressure, and lifetime are properties of the stream rather than callback bookkeeping.
- The Worker is a per-Run subprocess that runs to completion or interruption ([ADR-0013](./0013-worker-process-lifecycle-and-transport.md)). `Effect.gen` from main entry to exit gives structured cancellation for free — interruption propagates through every step without manual `AbortController` plumbing.
- The protocol surface needs runtime validation at the WebSocket and stdio boundaries. `Schema` is the bidirectional codec — decode from `unknown`, encode for the wire, parse failures are typed values rather than thrown exceptions.
- Errors at boundaries need to be typed and recoverable — a malformed Run Event, a Worker crash, a wire-protocol mismatch. Effect's typed-error channel makes the failure modes part of every signature instead of "anything could throw."
- Service injection (the `WsClient` singleton, future configuration sources, future Test Harness fakes) wants `Layer` rather than module-scoped state or constructor wiring.

Plain async/await delivers none of these as defaults. Each one would be re-invented locally — `AbortController` for cancellation, ad-hoc result types for typed errors, callback bags or RxJS for streams, hand-rolled DI for services. Effect bundles them coherently.

**Learning goal.** [ADR-0001](./0001-core-worker-split.md) names Inkstone's role as a vehicle for building real systems in Rust and TypeScript. Effect is one of the systems being learned. Adopting it on a project the author controls — small enough to reason about end-to-end, real enough to exercise the hard parts — is the point. Deferring Effect to a "real" project later means never adopting it. This rationale is recorded honestly so a future reader doesn't read the decision as accidental over-engineering.

## Where Effect shapes Inkstone

- **`packages/protocol`** — `Schema` is the source of truth for wire types on the TS side; type aliases are inferred via `S.Schema.Type<typeof X>`. Rust mirrors the same shapes by hand with `serde` per [ADR-0009](./0009-protocol-strategy.md).
- **`packages/worker`** — `main` is `Effect.gen` end-to-end. Reads stdin as a `Stream`, decodes via `Schema`, emits Run Events via `console.log`-equivalent within the Effect runtime, exits when the stream completes.
- **`packages/ui-sdk`** — `WsClient` is a `Context.Tag` exposed via a `Layer`. Methods return `Effect` (for request/response) and `Stream` (for `subscribeRun`). No singleton module state; the connection lives inside the `Layer`'s scope.
- **`apps/web`** — provides `WsClientLive` at the React root. Components consume Effects and Streams through `@effect/rx` Rx atoms; React state for streamed messages is updated as the Stream emits.

## Considered and rejected

- **Plain async/await + zod.** The default modern TypeScript stack: Promises for IO, zod for runtime validation, throw for errors. Rejected because every concern listed in *Why* would be re-invented locally — `AbortController` for cancellation that doesn't compose, ad-hoc Result types or thrown errors for typed failures, callback bags or a separate streaming library for Run Event routing, manual lifecycle wiring for the WebSocket. The cost is paid in scattered local idioms rather than one paradigm; the codebase becomes incrementally harder to reason about as each subsystem invents its own conventions.
- **Plain async/await + Effect Schema only** (the position this ADR walks back from). Use `Schema` for runtime validation, keep async/await + throw for everything else. Rejected because Schema's parser returns Effects — calling it from non-Effect code forces a `runPromise` boundary at every validator, and the decoded Effect has typed parse errors that have nowhere to go in throw-based code. The half-measure pays the cost of learning Schema without gaining structured concurrency, typed IO errors, or Stream. If Schema is in, the rest follows.
- **neverthrow / fp-ts / smaller FP libraries.** Adopt only the typed-error story (Result type), keep async/await for IO. Rejected because the streaming and structured-cancellation needs (Run Events, Worker interruption) want Stream and Fiber, not just Result. neverthrow solves a strict subset of what Inkstone needs.
- **Half-adoption** (Effect in `worker` and `ui-sdk` but not `apps/web`, or vice versa). Rejected because the Effect↔world boundary is the most expensive part of using Effect; concentrating it at every module boundary inside the codebase pays the boundary cost repeatedly. One ecosystem, one boundary at the React edge.

## Consequences

- **Bundle size in `apps/web`.** Effect core + `@effect/rx` + `@effect-rx/rx-react` is ~80KB gzipped — meaningful relative to a hand-rolled React app, irrelevant for a single-user local-first tool ([ADR-0007](./0007-local-first-single-user.md)) where the SPA loads from loopback.
- **Onboarding cliff.** A reader unfamiliar with Effect cannot navigate the TypeScript codebase without learning the basics (`Effect.gen`, `Layer`, `Stream`). Accepted as part of the learning goal.
- **Effect↔world friction.** Calling non-Effect libraries (browser APIs, `WebSocket`, the LLM SDK) requires `Effect.tryPromise` or `Effect.async` adapters. Concentrated at adapter modules; not pervasive once those are written.
- **Reversal cost is high.** Every IO-bearing TS function would change shape. The decision is recorded as load-bearing rather than provisional.
- **No matching Rust paradigm shift.** Core stays idiomatic Rust. The protocol mirroring across the boundary still happens by hand per [ADR-0009](./0009-protocol-strategy.md).

## Related

- [ADR-0001](./0001-core-worker-split.md) — names the learning-vehicle goal this ADR invokes alongside tool-fit.
- [ADR-0008](./0008-monorepo-shape.md) — `packages/protocol`, `packages/ui-sdk`, `packages/worker` and `apps/web` all carry the paradigm.
- [ADR-0009](./0009-protocol-strategy.md) — manual type mirroring; on the TS side, `Schema` is the authority that the contract tests in `bridges/` validate.
- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — Worker is `Effect.gen` from entry to exit; Effect's interruption matches the per-Run ephemeral process model.
- [ADR-0014](./0014-client-core-wire-protocol.md) — wire types are `Schema` on the TS side; `Stream` carries server-pushed Notifications.
