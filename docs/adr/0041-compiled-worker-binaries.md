# Compiled Worker / Provider-Helper binaries, resolved by Core

Core spawns the **Worker** (`packages/worker`, `cli.ts`) and the **Provider Helper** (`packages/provider-helper`, `provider.ts`) as child processes (ADR-0013, ADR-0023, ADR-0040). Today the only launch form is `tsx <script>` against a `node_modules`-resolved interpreter at a **repo-root-relative path** — a dev-time form with no shippable equivalent: it requires a Node toolchain, an installed `node_modules`, and Core's working directory to be the repo root.

This ADR adds a **shippable launch form**: each program compiles to a single self-contained executable (`inkstone-worker`, `inkstone-provider-helper`) via `bun build --compile`, and Core **resolves** which form to spawn through one ordered policy. It is hard to reverse (it fixes the resolution-order contract every spawn site obeys and commits the repo to `bun` as a build tool), surprising without context (it diverges from ADR-0040's offhand expectation that packaging would set the env overrides), and the result of a real trade-off (auto-detection vs explicit configuration; one combined binary vs two; `bun` vs `deno compile` vs Node SEA).

## Context

- **ADR-0013:** Core spawns the Worker as a child over subprocess stdio with NDJSON framing; Core owns the lifecycle. The transport is explicitly transport-independent and swappable.
- **ADR-0023:** the Provider Helper is a stateless OAuth process Core spawns (`login` / `refresh`); Core owns the Credential Store; the helper hands its result back on stdout.
- **ADR-0040:** the Provider Helper lives in its **own package** so each package "owns exactly one thing." It explicitly left **production cwd / packaging** out of scope, noting: *"if [a packaging layer] is added, it sets the env overrides to absolute paths (the seam already supports this)."*
- **ADR-0027:** scopes the Worker interpreter's "sole stdio site" to the Worker and excludes the helper as a separate binary.
- Spawn sites build a command today, each `env::var(...).unwrap_or_else(<relative tsx string>)` then **whitespace-split**: `worker/mod.rs` (`INKSTONE_WORKER_CMD`), `runs/provider.rs` (`INKSTONE_PROVIDER_LOGIN_CMD`), `provider_auth.rs` (`INKSTONE_PROVIDER_HELPER_CMD`), plus the one-shot title worker (`INKSTONE_TITLE_WORKER_CMD`, the same program as the Worker). The whitespace split mis-parses any path containing a space.
- A feasibility spike compiled all entry points with `bun build --compile` (`bun` 1.3.13) and ran them: the node-builtins fixture, the full interpreter tree (2491 modules: `pi-agent-core` + `effect` + `pi-ai`) driving a run offline, `provider.ts login` binding `:1455` and emitting a real PKCE `authorize_url`, and the real Core spawning a compiled binary and driving a run to completion. No native addons in the tree; the production entries read no sibling files at runtime.

## Decision

1. **Two binaries, one per package — not one combined binary.** `packages/worker` → `inkstone-worker`; `packages/provider-helper` → `inkstone-provider-helper` (argv `login` / `refresh`, as `provider.ts` already dispatches). A single combined binary would require a new shared entry that imports **both** packages and dispatches on argv — re-coupling at the entry point exactly what ADR-0040 split apart. The decision axis is **source coupling**, not artifact size: the spike showed the binary size is dominated by the embedded `bun` runtime (~60 MB), and the entire heavy interpreter tree adds only ~5 MB — so combining saves ~60 MB of disk at the cost of reversing a deliberate, fresh package boundary. On a local-first desktop install that trade is not worth taking.

2. **`bun build --compile` is the compiler.** The spike proved it runs the full `pi-ai` / `pi-agent-core` / `effect` tree, raw sockets (`:1455`), and PKCE/TLS init under the compiled runtime. `deno compile` and Node SEA are viable fallbacks but were not needed; `bun` cleared every level on the first try. This commits the repo to `bun` as a **build-time** tool (added to CI); it is not a runtime dependency of Core or of a shipped binary.

3. **Core resolves the launch form through one ordered policy**, applied per role (worker / titler / provider-login / provider-refresh — the titler runs the same program and `inkstone-worker` binary as the worker, with its own `INKSTONE_TITLE_WORKER_CMD` override so it stays independently injectable):
   1. **`INKSTONE_*_CMD` env override set** → use it, parsed with **`shlex`** (not whitespace-split, fixing the space-in-path bug). This is the **test seam** — every integration/e2e test points it at a `.ts` fixture via `tsx` — and the power-user / explicit-packaging escape hatch. It **always wins**.
   2. **else** → the **real program**: if a sibling executable (`inkstone-worker` / `inkstone-provider-helper`) exists next to Core's own executable (`current_exe`'s directory), spawn it.
   3. **else** → `tsx <script>` from the repo-root-relative source path (the dev-from-source form).

   Step 3 holds **only while no sibling binary is present**. Because `pnpm dev` runs `cargo run` (i.e. `target/debug/core`) and `build:worker` / `build:provider-helper` write to `target/debug/inkstone-worker` / `target/debug/inkstone-provider-helper` — siblings of that exe — a dev who has run a `build:*` script will find `pnpm dev` auto-detecting and spawning the **compiled (frozen) binary** at step 2 rather than live `tsx`, so subsequent edits to the worker/helper source are ignored until that binary is removed (`rm target/debug/inkstone-worker target/debug/inkstone-provider-helper`) or an `INKSTONE_*_CMD` override is set. The compiled artifacts live in git-ignored `target/`, so the shadowing is invisible to `git status`. This is the intended resolution order (a built binary next to Core is exactly what step 2 should prefer); it is called out here because the interaction with the `pnpm dev` hot-edit loop is non-obvious.

   The resolved command is centralized in **one resolver** that all three spawn sites call; the three inline `env::var + split` copies collapse into it.

4. **Test fixtures are reachable only through the env override (step 1), never through auto-detection (step 2).** Auto-detection resolves the **real** program only. There is no "dev uses a fake worker" default: with no override, Core always targets the real Worker / Helper (compiled binary if present, else `tsx` source).

## Why auto-detection, when ADR-0040 expected packaging to set the env vars

ADR-0040 anticipated a packaging layer setting `INKSTONE_*_CMD` to absolute binary paths. This ADR keeps that seam (step 1 still wins) but adds **sibling auto-detection** (step 2) as the zero-configuration path, because **there is no packaging layer yet** — and the point of this work is that a Core shipped next to its worker binaries *just works* without one. Auto-detection is a strict superset of ADR-0040's expectation: an explicit `INKSTONE_*_CMD` still overrides it, so a future packaging layer that sets absolute paths loses nothing. The cost is a small amount of "magic" (Core inspects its own directory); the benefit is that shipping = "place the binaries next to Core," with no launcher script required.

## Why the subprocess-stdio transport (ADR-0013) is unchanged

Only the **program** Core spawns changes — from `tsx <script>` to a compiled executable. The transport (child process, NDJSON over stdin/stdout, `kill_on_drop`, Core-owned lifecycle) is byte-for-byte identical; `ChildWorker` still spawns `(program, args)` and frames the same protocol. The OS-level Run isolation ADR-0013 relies on is preserved precisely because the worker stays a **separate process** — this ADR does **not** embed a JS engine into Core (which would reverse that isolation). The runtime under the worker's JS shifts from Node to `bun` for the compiled form; the spike validated `pi-ai`'s hot paths under it.

## What stays manual

A full real-provider Run (compiled `inkstone-worker` + a live OpenAI token completing a turn) stays a **manual smoke test** — it cannot run offline or in CI, exactly as the real Worker is untestable offline today (the faux interpreter stands in). Automated coverage proves: the binaries compile and boot; the Worker binary honors the terminal-event guarantee on a bad manifest; the Helper binary emits an `authorize_url`; and Core auto-detects + spawns a compiled (fixture) binary and drives a Run to completion.

## What stays out of scope

- **Cross-OS release matrix and downloadable artifacts.** `bun build --compile` produces a per-OS binary; a CI matrix that builds mac/linux/windows artifacts and uploads them to a GitHub Release is a separate feature. This ADR adds only a build script and a single-host CI build step that gates compilation.
- **Embedding the binaries into Core.** ADR-0040's seam is path-based (sibling executable / env override), not embed-based. The web-bundle embed (ADR-0015) is now built; a unified single-binary bundle remains deferred as a separate decision.
- **Desktop shell / installer.** No Tauri/Electron/installer exists; none is added.
- **`pi-ai` version governance.** The worker and helper pin `0.74.0` by hand (ADR-0040); unchanged.

## Considered and rejected

- **One combined binary (argv `run` / `login` / `refresh`).** Rejected: re-couples the two packages ADR-0040 split, to save ~60 MB of mostly-runtime disk. Source boundary > artifact size on a desktop install.
- **Env-override only; no auto-detection (rely on a future packaging layer to set `INKSTONE_*_CMD`).** Rejected: leaves no zero-config path, so a shipped Core can't find its worker without an external launcher that doesn't exist yet — the gap this ADR closes.
- **`cfg!(debug_assertions)` picks tsx vs binary.** Rejected: a release Core could then never run `tsx` (awkward for testing a release build), and the env override has to special-case around the compile flag. Presence-of-binary is a cleaner signal than build profile.
- **Embed a JS engine in Core (run the worker in-process).** Rejected: reverses ADR-0013's process isolation, drags a V8/JS-engine dependency into Core, and the only crate that ships the needed Node-compat surface (`deno_runtime`) couples Core's release cadence to it. The worker stays a child process.
- **`deno compile` / Node SEA as the compiler.** Held as fallbacks. `bun` cleared the spike on the first try; if a `bun`-specific runtime incompatibility surfaces later, the resolver is unaffected — only the build script changes.

## Related

- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — subprocess-stdio transport; this ADR changes only the spawned program, not the transport.
- [ADR-0023](./0023-provider-oauth-core-owned-credentials.md) — the Provider Helper's reason for existing; unchanged in substance.
- [ADR-0027](./0027-worker-interpreter-transport-seam.md) — "sole stdio site" scoped to the Worker; the helper is a separate binary, now also a compiled one.
- [ADR-0040](./0040-provider-helper-own-package.md) — the package split this ADR conforms to; this ADR makes its deferred "packaging" note concrete, choosing sibling auto-detection over env-var-only.
- [ADR-0015](./0015-web-client-packaging.md) — the single-binary web embed, now built; a unified bundle remains a separate deferred decision.
