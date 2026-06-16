# Monorepo shape

Inkstone is a single repository combining a Rust Cargo workspace and a pnpm workspace, with the following top-level layout:

```
apps/web/             React Web Client
crates/core/          Core daemon (Rust)
packages/protocol/    Shared protocol definitions (TypeScript side)
packages/ui-sdk/      Client-to-Core wrapper consumed by Clients
packages/worker/      Worker (TypeScript)
tests/                Test area: end-to-end harness (tests/e2e) + cross-language contract tests (tests/contract)
```

## Why the cross-language monorepo

Core and Worker evolve together; their protocol changes in lockstep with both sides. Splitting them across repositories would force every protocol change into a synchronized two-PR dance, which is friction without benefit at this stage.

The pnpm + Cargo combination keeps each side using its native workspace tooling rather than forcing one ecosystem to wrap the other.

## Why no `shared/`

A catch-all `shared/` package becomes a junk drawer: anything two packages need ends up there, and the boundary blurs. Each shared concept gets its own named package (`protocol`, `ui-sdk`, future ones as needed), so the dependency graph stays legible.

## Why `protocol` and `ui-sdk` are separate packages

`protocol` is the wire-level type vocabulary — Run Events, Tool Requests, Tool Results, message envelopes. `ui-sdk` is the higher-level Client → Core wrapper that consumes `protocol` and presents Clients with a more ergonomic API (typed methods, lifecycle, reconnection, etc.).

Combining them would force every Client to depend on the wire types directly, defeating the wrapper's purpose. Keeping them split also lets the Worker depend on `protocol` without dragging in Client-side concerns.

## Cross-language contract tests live under `tests/`

Contract and integration tests — the place where Rust and TypeScript actually exercise each other through the protocol — live in `tests/contract` (the first such package is `@inkstone/contract`, the wire-schema parity gate). They sit alongside the full-system Playwright harness in `tests/e2e`: `tests/` is the repo's test area, with `tests/contract` for no-DOM protocol/round-trip/schema tests and `tests/e2e` for behavioral tests through the Web Client. Distinct from per-package unit tests; `tests/contract` is where we catch protocol drift.

(Originally a dedicated top-level `bridges/` directory; superseded — contract tests folded under `tests/` so the repo root carries no extra top-level test directory. The `tests/e2e` ↔ `tests/contract` boundary is the same one ADR-0019 draws.)

## Out of scope

- Choice of task-runner (Moon, Turborepo, Nx, plain scripts). That stays a code decision and does not need ADR commitment yet.
- Whether `apps/` will hold non-Web Clients (TUI, Desktop) or whether each gets its own folder shape. Decided when those Clients exist.

## Related

- [ADR-0009](./0009-protocol-strategy.md) — how `protocol` types stay consistent between Rust and TypeScript.
