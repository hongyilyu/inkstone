# LayoutContext — Design Notes

`src/tui/context/layout.tsx` exposes a single Solid context (`LayoutContextValue`) that owns the imperative handles the rest of the TUI needs:

- the conversation scrollbox renderable
- the prompt textarea ref
- the prompt's Ctrl+C decision bridge

This file documents *why* the context is shaped the way it is — the rationale that would otherwise bloat the source file's headers.

## Why a context (and not module-scoped state in `app.tsx`)

Earlier iterations of Inkstone kept these handles as `let scroll: ... = null` etc. directly in `app.tsx`. That worked but had three persistent costs:

- **Lifecycle drift.** Module state outlives Solid's component lifecycle. Every ref callback had to do an `onCleanup` identity-check (`if (registered === ref) registered = null`) so a late cleanup from a previous mount couldn't clobber a fresh mount's handle.
- **Test reset.** Re-rendering the harness (one test → next) inherited the previous render's refs. Any test that read a stale ref hit the stale renderable's `isDestroyed` path at best, undefined behavior at worst.
- **Layering.** Action and reducer modules that need to scroll the conversation or read the prompt buffer had to import side-effecting symbols from `@tui/app`. The action layer drove a layout side effect through a global, which is exactly the layering inversion the bridge / context layout was meant to prevent.

The provider-scoped closure in `LayoutProvider` solves all three: handles live in the closure, the closure dies with the provider on unmount, and consumers read through `useLayout()` — a typed surface that's mockable in tests.

## `getActiveLayout()` — the cross-tree escape hatch

`useLayout()` requires a `LayoutProvider` ancestor. It works for components inside the JSX subtree (`Conversation`, `Prompt`, `Sidebar`, etc.) and hooks called by those components (`useLayoutKeybinds`).

It *doesn't* work for callers outside the subtree. The action layer (`tui/context/agent/actions/*.ts`) and reducer (`tui/context/agent/reducer.ts`) are invoked from inside `AgentProvider`, which is a *parent* of `LayoutProvider`. They have no `useLayout()` call site that wouldn't violate Solid's owner contract.

`getActiveLayout()` is the bridge. It's a module-scoped pointer the provider sets on mount and clears on cleanup — only ever readable when a provider is mounted, returns `null` otherwise. Callers null-check and fall through:

```ts
getActiveLayout()?.scrollToBottom();
```

This isn't a workaround for a missing feature; it's the deliberate escape hatch for "I need the layout primitive but I don't run inside its tree." The downside (only one provider can be active at a time) is fine because there's only ever one `LayoutProvider` instance in the app — and would still be enforced even if there weren't, since the latest `LayoutProvider`'s mount overwrites the pointer.

## `PromptCtrlCBridge` — why a bridge, not a second `useKeyboard`

The two-stage Ctrl+C behavior (clear input → arm "again to exit" → exit) needs state that lives in the `Prompt` component (`exitArmed` signal, 5s timer, the textarea contents) but reacts to a key event that *must* be intercepted at the layout level.

Why not a `useKeyboard` handler in `Prompt`? OpenTUI's EventEmitter dispatches global listeners in registration order, and the layout's `onMount` (parent) registers before the prompt's (child). A prompt-level handler would fire *after* the layout's `app_exit` handler — by which point the renderer has already been destroyed.

So the Prompt publishes its decision callbacks (`decide` / `clear` / `arm` / `disarm`) into the context on mount, and `useLayoutKeybinds` calls them inside the single layout-level `useKeyboard` handler. Mount order becomes irrelevant because there is only one handler. The bridge is null when `Prompt` isn't mounted (boot fallback, approval / suggestion panel surfaces) — the layout handler then falls back to immediate exit, matching pre-existing behavior on those surfaces.

The state machine itself lives in `src/tui/components/prompt-ctrlc.ts` (a pure function `deriveCtrlCAction`) so unit tests can pin the table without standing up a full OpenTUI render.

## Adding a new layout-level handle

If a future feature needs another imperative handle (mouse position, an overlay ref, etc.), add it to `LayoutContextValue` with the same shape: a setter called from the owning component's ref callback, an identity-checked clearer in `onCleanup`, a getter for read sites. If callers outside the JSX subtree need it too, expose them through `getActiveLayout()` rather than a new module-scoped pair.
