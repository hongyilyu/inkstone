# Web Client packaging: Vite in dev, embedded in Core in prod

The Web Client's static assets (HTML, JS bundle, CSS, images) reach the browser two different ways depending on the environment:

- **Production**: `pnpm build` in `apps/web` produces a `dist/` directory. Core embeds those files into its binary at compile time using `rust-embed` (or equivalent) and serves them from the same TCP listener that handles the WebSocket. The shipping artifact is a single binary.
- **Development**: Vite runs its own dev server (e.g. on port 5173) for hot module reload. Vite is configured to proxy `/ws` to Core's port. The browser opens Vite's port, gets the SPA from Vite, and the SPA's WebSocket call hits Vite which forwards to Core.

In both cases, Core's HTTP+WebSocket server is unchanged. Only the source of the SPA bytes differs.

> **As built (HEAD): the embedded-SPA production path is implemented.** `crates/core/src/web_embed.rs` — compiled only in release via a `#[cfg(not(debug_assertions))]` `mod` gate in `main.rs` — derives `rust-embed` (with the `mime-guess` feature for content types) over `apps/web/dist/` and serves the SPA rows of the routing table below as the router's GET/HEAD fallback handler (`/ws` stays a registered route with precedence). The derive inhales `dist/` at compile time, so the web build must precede the cargo release build; `pnpm build:release` encodes that ordering, and CI's `build:release boot-smoke` step asserts the shipped binary serves the SPA. Debug builds are unchanged: `INKSTONE_WEB_DIR` → `ServeDir`/`ServeFile` from disk in dev (ADR-0019), the bare `"Inkstone Core"` liveness string without it, and release still ignores the env var (never serves from disk). The "version mismatch impossible by construction" guarantee now holds.

## How the production listener routes requests

Core opens a single TCP listener on `127.0.0.1:PORT`. The HTTP server handles:

- `GET /` → embedded `index.html`.
- `GET /assets/*` → embedded CSS / JS / images.
- `GET /ws` with WebSocket upgrade → JSON-RPC frames per [ADR-0014](./0014-client-core-wire-protocol.md).
- Any other path → embedded `index.html`. The SPA's TanStack Router reads `window.location` and renders the right view client-side.

The "any other path → `index.html`" rule is the SPA fallback. TanStack Router is a client-side router; deep links like `/threads/abc` must return the SPA shell, not 404, so the router can take over after JS loads.

## Why embed the SPA in the binary

- **One artifact to ship.** No "Core binary plus assets directory" deployment story. Copy the binary, run it, done.
- **Version mismatch impossible by construction.** The SPA shipped with the binary is exactly the SPA that built against this Core's protocol. The runtime `schema_hash` we considered for [ADR-0014](./0014-client-core-wire-protocol.md) is unnecessary precisely because production cannot drift.
- **No path-resolution surprises.** `rust-embed` reads from compile-time paths; the runtime has no dependency on where the binary was launched from.

The cost is rebuild-on-asset-change in production builds — a non-issue because production builds happen at release time, not in the inner loop.

## Why Vite in development

- **Hot module reload.** Editing a React component reloads in the browser without rebuilding Core. The inner loop is React-only when the wire types haven't changed.
- **Standard dev experience.** Vite is the canonical TS/React dev server; it Just Works with TanStack Router, TypeScript, JSX, etc.
- **Vite proxies `/ws` to Core.** The browser still sees one origin (Vite's port); WebSocket calls are transparently forwarded. Core doesn't need to know Vite exists.

The dev path requires running two processes (Core on its port, Vite on 5173). That's a normal monorepo dev experience and is the standard cost of hot reload.

## What this does not decide

- **Whether Core spawns the browser** on first launch, or the user navigates manually. UX detail, not architectural.
- **Whether the binary is delivered as a Tauri / Electron app, a CLI binary, or a system service.** Distribution-time decision; this ADR only commits to "the binary serves the SPA."
- **Asset-versioning / cache-busting policy.** Production assets are immutable per build (Vite produces hashed filenames by default); no extra policy needed in MVP.

## Considered and rejected

- **Separate static-asset server in production.** Forces a deployment story with two processes and inter-process file sharing. Buys nothing on a single-user local-first app.
- **No build embedding; serve from `dist/` on disk in production.** Adds a runtime path-resolution dependency and risks "ran the binary from the wrong directory" failures. `rust-embed` removes the failure mode entirely.
- **Tauri / Electron from the start.** Real eventual fit, especially for capture-from-share-sheet, system-tray launch, and OS integration. Out of scope for the chat-driven Web Client MVP per [ADR-0010](./0010-mvp-slice-chat-driven-web-client.md). Revisit when those features land.
- **Vite-only forever (no embedded assets in prod).** Means the user must run a TS dev server in production. Unacceptable for a personal-app MVP that should be one binary.

## Related

- [ADR-0010](./0010-mvp-slice-chat-driven-web-client.md) — Web Client is the only Client surface in MVP.
- [ADR-0014](./0014-client-core-wire-protocol.md) — what the WebSocket actually carries.
