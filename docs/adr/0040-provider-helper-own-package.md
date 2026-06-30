# The Provider Helper lives in its own package, not inside `packages/worker`

The **Provider Helper** — the stateless OAuth process Core spawns to run LLM-provider `login`/`refresh` via `pi-ai` (ADR-0023) — moves out of `packages/worker` into its own workspace package, **`packages/provider-helper`**. `packages/worker` is now exactly the **Worker**: the per-Run subprocess that drives Runs over the Tool Protocol. Core reaches the helper through the same `INKSTONE_PROVIDER_HELPER_CMD` / `INKSTONE_PROVIDER_LOGIN_CMD` command-string seam as before; only the default command's path changed.

## What this means concretely

- **`packages/provider-helper/`** is a standalone package: its own `package.json` (depends on `@earendil-works/pi-ai` pinned `0.74.0` to match the Worker, its own `tsx`), its own `tsconfig.json` (mirrors the Worker's `noEmit` typecheck), and `src/provider.ts` moved verbatim (a pure git rename — history preserved, zero content change).
- **Core's two default spawn commands repoint** to `packages/provider-helper/node_modules/.bin/tsx packages/provider-helper/src/provider.ts {refresh,login}`. (These defaults were later centralized into `launch.rs` per [ADR-0041](./0041-compiled-worker-binaries.md), as the `Role::ProviderRefresh` / `Role::ProviderLogin` arms of `tsx_default`; they were originally inline in `provider_auth.rs` and `runs/provider.rs`.) The env-override seams `INKSTONE_PROVIDER_HELPER_CMD` / `INKSTONE_PROVIDER_LOGIN_CMD` are unchanged in name and meaning.
- **Nothing on the wire changes.** The helper's NDJSON protocol (`{kind:"credentials"|"authorize_url"|"error", ...}`, snake_case `account_id`) and the two test stubs (`crates/core/tests/fixtures/{refresh,login}-helper.ts`, selected via the env overrides) are untouched.
- **The Core↔helper seam stays a real port (two adapters):** the production `provider.ts` and the per-mode test stubs. The split relocates one adapter; it does not change the seam.

## Why split it out

`CONTEXT.md` already names the Provider Helper *"Distinct from the Worker (which drives Runs) though both live in `packages/worker` and depend on `pi-ai`."* Co-locating two unrelated programs — one driving a Run, one doing OAuth — in a single package made the package's interface "two programs," not "one deep capability": the depth verdict for `packages/worker` read as **mixed**, not deep. Moving the helper out leaves `packages/worker` owning exactly one thing, so its interface is a small surface over the real agent-loop machinery (interpreter + transport + tool-proxy). The helper shares **nothing** with the interpreter — it imports only `pi-ai` and `pi-ai/oauth`, has its own `main()`/argv protocol — so the move severs no internal coupling.

## Why a full package, not a sibling entry

The new home gets its **own `tsx`**, so Core's default command points entirely inside `packages/provider-helper/`. The alternative — leave the file with its own `package.json` but borrow `packages/worker`'s `tsx` — was rejected: it would leave the helper's launch threaded back through the Worker, a partial split that re-introduces the coupling the move exists to remove. The cost of a self-contained package (one extra dev dependency install) is trivial; the honesty of "the helper stands on its own" is the point.

## What stays out of scope

- **Production cwd / packaging.** The default command is repo-root-relative, like `INKSTONE_WORKER_CMD`. There is no desktop/packaging layer in the repo today that would launch Core from a different cwd; if one is added, it sets the env overrides to absolute paths (the seam already supports this). Not changed here.
- **`pi-ai` version governance.** The helper pins `0.74.0` to match the Worker by hand; there is no workspace catalog enforcing it. If a catalog is introduced, both pins move to it.

## How this refines earlier ADRs

- **[ADR-0023](./0023-provider-oauth-core-owned-credentials.md):** unchanged in substance — Core still owns the Credential Store; the helper is still stateless, spawned per operation, and never sees the durable store. This ADR only changes *where the helper's code lives*.
- **[ADR-0027](./0027-worker-interpreter-transport-seam.md):** already scoped its "sole `process.stdin`/`stdout` site" claim to the Worker interpreter transport and excluded the Provider Helper as "a separate binary." That exclusion is now physical: the helper is a separate package. The ADR-0027 reference to the helper's path is updated accordingly.

## Considered and rejected

- **Leave the helper in `packages/worker`.** Rejected: keeps the package's interface at "two programs" and the depth verdict at mixed — the status quo this move exists to fix.
- **New `package.json` but reuse the Worker's `tsx`.** Rejected: a partial split that leaves the helper's launch coupled to the Worker; defeats the "owns exactly one thing" goal.
- **Introduce a package `bin`/`exports` entry for the helper.** Rejected as unneeded: Core reaches it by file path passed to `tsx`, exactly as it reaches the Worker's `cli.ts`. No published interface is required.

## Related

- [ADR-0023](./0023-provider-oauth-core-owned-credentials.md) — Core-owned OAuth credentials; the helper's reason for existing.
- [ADR-0027](./0027-worker-interpreter-transport-seam.md) — scopes the Worker transport's "sole stdio site" claim to exclude this helper.
- `docs/design/provider-helper.md` — the helper's module-level design notes.
