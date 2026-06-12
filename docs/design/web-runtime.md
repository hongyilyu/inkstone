# web-runtime design notes

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## apps/web/src/runtime.tsx — deriveWsUrl

Derive the Core WebSocket URL from the page's location, so a Core-served SPA
dials back the same Core that served it — on whatever (possibly ephemeral)
port that is. `http:` → `ws:`, `https:` → `wss:`, same host, `/ws` path.

In Vite dev the page is served from Vite's port; its `/ws` is proxied to
Core (see `vite.config.ts`), so the same-origin URL still reaches Core.
Production embeds the SPA in Core, so location IS Core. The harness
(ADR-0019) relies on this to avoid hardcoding Core's port in the bundle.

## apps/web/src/runtime.tsx — RuntimeProvider

Holds one `WsRuntime` for the React tree and exposes it via context.

Injection seam (slices 11–13 drive a stub `WsClient` through here):
  - `runtime` prop → used directly
  - else `layer` prop → `ManagedRuntime.make(layer)`
  - else built from `config` (default: same-origin via `deriveWsUrl`) via `makeWsLayer`

Laziness: `ManagedRuntime.make` does NOT run the layer — `WsClientLive` is
`Layer.scoped` and only opens the socket when the runtime first RUNS an
effect needing `WsClient`. Mounting opens ZERO sockets (we never call
`runFork`/`runPromise` here). The runtime is built once per mount via a lazy
`useState` initializer so re-renders don't rebuild it.

Disposal: not wired here. The runtime is page-lifetime-scoped, and disposing
in a `useEffect` cleanup is NOT StrictMode-safe — StrictMode's mount→unmount→
remount would dispose the very runtime the persisted `useState` value still
holds. Since the runtime is lazy (no socket until an effect runs), an
undisposed-yet-unused runtime holds no resources anyway.

## apps/web/src/routes/library/route.tsx — LibraryLayout

Library shell (peer to Chat, reached from the sidebar). Composes the shared
`WorkspaceShell` (ADR-0021): the same framed middle as the chat surface, plus
the same collapsible right rail.

The rail mounts only when a row is selected. Selecting a row sets `?id` on the
*current* route, so the detail Inspector opens in place rather than switching
views — and only then does the card carry the carved bay and its collapse
toggle. With nothing selected the shell renders a plain framed card (no bay,
no toggle), so the bay/toggle always signal "there is content here". On
selection the rail opens; the collapse toggle then hides it to a sliver while
keeping the selection (the bay stays), and a manual toggle wins until the
selection changes. The bay disappears again once nothing is selected (e.g.
navigating to another collection).

The rail is the pink chrome (`bg-sidebar`), matching the chat surface's
activity rail and the bay — not the white reading surface.
