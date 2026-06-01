# Effect across the TypeScript codebase

TypeScript modules in Inkstone are written on top of [Effect](https://effect.website). Runtime schemas, IO-bearing functions, service injection, and asynchronous streams use Effect's primitives — `Schema`, `Effect`, `Layer`, `Stream`, `Fiber` — instead of plain async/await + zod + ad-hoc class-based services. React consumes Effect at the boundary through a single `ManagedRuntime` plus a thin bridge into plain React state — **not** through an Effect React-binding library.

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
- **`apps/web`** — provides `WsClientLive` at the React root through a single `ManagedRuntime`. SDK methods run on that runtime; the `subscribeRun` `Stream` is forked on it and a thin imperative bridge pushes its events into plain React state (a small store). React state for streamed messages is updated as the Stream emits. No Effect React-binding library — see *React boundary* below.

### React boundary: `ManagedRuntime` + thin bridge, no binding library

React consumes Effect through one `ManagedRuntime` (built from `WsClientLive`) exposed at the root, plus a thin bridge: SDK request Effects are run on the runtime; the `subscribeRun` `Stream` is forked on the runtime (`runtime.runFork(Stream.runForEach(stream, applyEvent))`) and its events are pushed into a plain store, with the per-run fiber interrupted on `done`/unmount for structured cleanup. React state itself is plain (a small store), not Effect-bound.

This deliberately omits an Effect React-binding library (`@effect-atom/atom-react`, formerly `@effect/rx` / `@effect-rx/rx-react`). The earlier draft of this ADR named `@effect/rx`; it was aspirational and never implemented. The reference implementation the project validates against (t3code) has a far more complex streaming-chat UI and uses exactly this pattern — Effect at the wire boundary, a plain store (zustand) for React state, an imperative callback bridging the subscription into the store — with **no** Effect React-binding library. The only capability such a library adds for Inkstone is a declarative stream→render primitive, which is a few lines of `runFork` + `Stream.runForEach` + fiber-interrupt against the runtime we already hold. Adding a young (0.x) dependency and a second state paradigm to save those lines is not worth it for a single-user tool; revisit only if the React surface grows enough that hand-bridged streams become a maintenance burden.

## Considered and rejected

- **Plain async/await + zod.** The default modern TypeScript stack: Promises for IO, zod for runtime validation, throw for errors. Rejected because every concern listed in *Why* would be re-invented locally — `AbortController` for cancellation that doesn't compose, ad-hoc Result types or thrown errors for typed failures, callback bags or a separate streaming library for Run Event routing, manual lifecycle wiring for the WebSocket. The cost is paid in scattered local idioms rather than one paradigm; the codebase becomes incrementally harder to reason about as each subsystem invents its own conventions.
- **Plain async/await + Effect Schema only** (the position this ADR walks back from). Use `Schema` for runtime validation, keep async/await + throw for everything else. Rejected because Schema's parser returns Effects — calling it from non-Effect code forces a `runPromise` boundary at every validator, and the decoded Effect has typed parse errors that have nowhere to go in throw-based code. The half-measure pays the cost of learning Schema without gaining structured concurrency, typed IO errors, or Stream. If Schema is in, the rest follows.
- **neverthrow / fp-ts / smaller FP libraries.** Adopt only the typed-error story (Result type), keep async/await for IO. Rejected because the streaming and structured-cancellation needs (Run Events, Worker interruption) want Stream and Fiber, not just Result. neverthrow solves a strict subset of what Inkstone needs.
- **Half-adoption** (Effect in `worker` and `ui-sdk` but not `apps/web`, or vice versa). Rejected because the Effect↔world boundary is the most expensive part of using Effect; concentrating it at every module boundary inside the codebase pays the boundary cost repeatedly. One ecosystem, one boundary at the React edge.

## Consequences

- **Bundle size in `apps/web`.** Effect core is meaningful relative to a hand-rolled React app, irrelevant for a single-user local-first tool ([ADR-0007](./0007-local-first-single-user.md)) where the SPA loads from loopback. No Effect React-binding library is added (see *React boundary*), so the only Effect cost in the bundle is core.
- **Onboarding cliff.** A reader unfamiliar with Effect cannot navigate the TypeScript codebase without learning the basics (`Effect.gen`, `Layer`, `Stream`). Accepted as part of the learning goal.
- **Effect↔world friction.** Calling non-Effect libraries (browser APIs, `WebSocket`, the LLM SDK) requires `Effect.tryPromise` or `Effect.async` adapters. Concentrated at adapter modules; not pervasive once those are written.
- **Reversal cost is high.** Every IO-bearing TS function would change shape. The decision is recorded as load-bearing rather than provisional.
- **No matching Rust paradigm shift.** Core stays idiomatic Rust. The protocol mirroring across the boundary still happens by hand per [ADR-0009](./0009-protocol-strategy.md).

## t3code comparison (web architecture)

Inkstone validates its web client against t3code, an all-TypeScript streaming-chat
reference. Re-examining t3code's web architecture after wiring the Web Client to Core
(PRs #28–#41) confirms which of its patterns transfer and which the Rust/TS split
makes unreachable.

**`@effect/rpc` over the wire — does not transfer.** t3code's `RpcClient`/`RpcServer`
work because one `RpcGroup` generates *both* ends in TypeScript, so @effect/rpc owns
the framing: request ids, chunk/exit, ack-based stream backpressure. Inkstone's WS
server is Rust Core (serde + tokio). Pointing `RpcClient` at Core would force Core to
reimplement @effect/rpc's framing in serde — inverting protocol ownership away from
the hand-mirrored JSON-RPC envelope. Rejected; the wire contract stays owned by
[ADR-0014](./0014-client-core-wire-protocol.md).

**Shared `contracts` package — does not transfer.** t3code shares one `RpcGroup` for
client and server. Inkstone hand-mirrors Effect `Schema` (TS) ↔ `serde` (Rust) with
contract tests per [ADR-0009](./0009-protocol-strategy.md). Type codegen
(typeshare / ts-rs) emits plain TS types, not `Schema`, so it would lose the runtime
decode at the wire boundary that this ADR depends on. Nothing in t3code changes that
calculus. Rejected.

**Zustand for domain/streaming state, not `@effect/atom`.** t3code keeps its large
streaming domain state (threads/messages) in plain Zustand and reserves an Effect
React-binding only for second-tier request state. Adopting atoms for chat state would
*contradict* t3code's own split. Inkstone's chat store therefore stays a plain store
(migrated to Zustand for ergonomics — a `apps/web`-local dependency, not a Rust-side
one), consistent with the *React boundary* section above. Atoms remain available for
any future second-tier state but are not adopted for the streaming path.

**The Stream→store bridge is inherent and retained.** Even t3code keeps a manual
`Stream.runForEach` bridge from the subscription into its store. The Stream→store seam
is a property of consuming a server-pushed stream in React, not an artifact we can
delete. Inkstone keeps its equivalent bridge (`apps/web/src/store/bridge.ts`); see the
*React boundary* section.

**Stay on effect 3.x stable.** t3code runs effect 4.0.0-beta; Inkstone runs effect
3.x stable. `@effect/platform` Socket and Zustand both support 3.x, so no forced beta
upgrade is needed. t3code's 4.x-beta patterns are noted for future reference but not
adopted.

## Related

- [ADR-0001](./0001-core-worker-split.md) — names the learning-vehicle goal this ADR invokes alongside tool-fit.
- [ADR-0008](./0008-monorepo-shape.md) — `packages/protocol`, `packages/ui-sdk`, `packages/worker` and `apps/web` all carry the paradigm.
- [ADR-0009](./0009-protocol-strategy.md) — manual type mirroring; on the TS side, `Schema` is the authority that the contract tests in `bridges/` validate.
- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — Worker is `Effect.gen` from entry to exit; Effect's interruption matches the per-Run ephemeral process model.
- [ADR-0014](./0014-client-core-wire-protocol.md) — wire types are `Schema` on the TS side; `Stream` carries server-pushed Notifications.
