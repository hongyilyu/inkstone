# URL-addressable Threads: the route is the source of truth for thread focus

The chat surface was the only navigational surface whose location lived nowhere
in the URL. The Library addresses its content (`/library/$kind?id=<entityId>`);
chat sat at a single static `/`, with the focused Thread held only in the Zustand
store (`focusedThreadId`) and the scroll-to-message anchor held as a transient
store field (`focusedMessageId`, issue #138). Two users — one reading a Thread,
one reading an Entity — occupy the same *kind* of place, but only one was
addressable. That asymmetry is the smell, and it has concrete costs: a reload
drops you on the welcome screen (the store reinitializes empty), and there is no
way to share or bookmark a link to a Thread or a specific Message.

We make the **URL the single source of truth for which Thread is focused and
which Message is anchored**. `focusedThreadId` and `focusedMessageId` leave the
store entirely; the route owns both. No new limitation forced this — it is an
architectural-consistency decision, taken while the app is pre-release and the
change is cheap (Core's focus→`thread/get` hydration already rebuilds a Thread
from just its id).

## Decision

- **URL shape `/thread/$threadId`**, namespaced to mirror `/library/$kind`. `/`
  is unconditionally the new-chat welcome; a focused Thread is *only ever*
  `/thread/<id>`. The Message anchor is the search param `?focusedMessageId=<id>`.
- **URL is the single source of truth.** `focusedThreadId`, `setFocusedThread`,
  `clearFocusedThread`, `useFocusedThreadId`, `focusedMessageId`, `focusMessage`,
  `clearFocusedMessage`, and `useFocusedMessageId` are all deleted from the chat
  store. Switching Threads is a `navigate()`, not a store mutation. Verified safe:
  no store-internal code reads either field — `hydrate.ts` takes the focused id
  as a *parameter*, not from the store.
- **A thin pathless `_chat` layout route** owns the shared `WorkspaceShell`
  (Sidebar + recent-Runs rail) and renders an `<Outlet/>`; `/` and `/thread/$id`
  render only the center via the outlet. The shell never remounts across the
  welcome↔Thread crossing. "Thin": `ChatColumn` (messages + composer) stays whole
  in the outlet — the composer is *not* hoisted into the layout.
- **`ChatColumn` becomes router-aware.** It reads the focused id via
  `useParams({ strict: false })` and navigates via `useNavigate()`, exactly as
  `routes/library/route.tsx` does. This revisits the informal "router-free,
  navigation injected as props" convention and the issue #138/#169 stance of
  "store anchor, not route param, to keep `ChatColumn` router-free." That stance
  predates chat having any URL identity; it is superseded here. (It was never an
  ADR — the `ADR-0024` citation on the file-based router in `main.tsx` misattributes it; ADR-0024 is
  user-configurable-model-and-effort and says nothing about routing.)
- **The Message anchor is consume-then-strip.** On arrival, `ChatColumn` scrolls
  the anchored Message into view and blooms the lamplight highlight, then strips
  the param with `navigate({ replace: true })`. This preserves issue #138's
  one-shot semantics (a later re-render can't re-fire a stale highlight) and
  avoids a stale anchor lingering in the address bar. The cold-Thread gate is
  unchanged: the param waits in the URL until the anchored Message is in the
  rendered list (after `thread/get` hydrates), then strips. The visual highlight
  remains ephemeral local component state with its ~1.6s fade.
- **Thread navigation pushes history; anchor-strip replaces.** Back/forward walks
  the Thread stack (matching Library's `?id=` push behavior); the consume-then-
  strip never adds a junk entry. The recent-Runs rail, which previously focused a
  Thread in place with no route change, becomes a normal history-writing
  navigator like every other Thread-opener.
- **Mint-on-send navigates from React, not the bridge.** `sendNewThread` no
  longer calls `setFocusedThread`; it returns the new `thread_id`, and
  `ChatColumn` awaits it and navigates to `/thread/$id`. On failure (the
  `threadCreate` threw) it stays on `/` and surfaces the existing send error.
- **Unknown Thread id → an honest not-found state (B-additive).** A
  `/thread/<bad-id>` whose `thread/get` rejects with `UnknownThreadError` (Core
  JSON-RPC `-32001`, already mapped end-to-end in the SDK) renders a dedicated
  "This thread isn't available" empty state with a *Back to New Chat* action,
  mirroring the Library's "Unknown collection" card. This is added *alongside* the
  existing issue #108 fetch-error/retry path, which is left untouched — a transient
  `WsRequestError` on a valid Thread still shows the recoverable retry affordance.

## Why URL-authority, not store-mirror

The honest version of "address the Thread" is to let the URL *own* the focus, not
to keep the store field and sync it to the URL. A two-way store↔URL mirror is a
dual-source-of-truth bug farm — the exact thing the Library avoids by reading
`?id=` directly with no store copy. Mirroring would also undercut the entire
consistency rationale: we would have made chat *look* addressable while keeping
the old store-authority underneath. Deleting the store fields is what makes the
URL real.

The reason this is cheap is that the focus→hydrate machinery already exists:
`useHydrateFocusedThread` fires `thread/get` on any focused id it has not seen,
and `sendNewThread` pre-marks a freshly-minted Thread `hydration: "ready"` so the
optimistic seed is not clobbered. The URL change only swaps *where the id comes
from* (route param instead of store), not how a Thread rebuilds itself.

## Consequences

- **Reload-survival and shareable/bookmarkable links fall out for free.** A
  reload onto `/thread/<id>` cold-hydrates via `thread/get`; a copied URL lands a
  recipient on the same Thread (and, transiently, the same Message).
- **Cold-load scroll position is now a real case.** Previously a reload always
  landed on welcome, so the mount-only "scroll to bottom" was sufficient. With
  cold-load as a primary path, `ChatColumn` re-scrolls to the bottom when
  hydration fills the message list — *unless* a `?focusedMessageId` anchor is
  pending, in which case the anchor scroll wins. Scroll priority: anchor →
  messages-arrived-bottom → live-streaming-stick-to-bottom.
- **Streaming survives the welcome→Thread remount.** The first send mints+seeds+
  forks a Run, then navigates, which remounts `ChatColumn` (the center swaps from
  welcome to Thread). The stream is unaffected: run fibers live in a module-level
  `Map` in `store/bridge.ts`, decoupled from React lifecycle, and `ChatColumn` has
  no unmount interrupt (the only fiber interrupts come from `cancelRun` /
  `decideProposal`). The seeded turn survives because the Thread is pre-marked
  `ready`.
- **The Library's `_chat` twin.** Chat and Library now share the exact structure:
  a layout route owning `WorkspaceShell` + `<Outlet/>`, children reading
  params/search. New surfaces follow one pattern.
- **`scroll-to-message` e2e changes premise.** Its reload step asserted
  `userBubbles().toHaveCount(0)` — premised on store-only focus dropping on
  reload. Reload-survival breaks that; the spec is migrated to assert the anchor
  jump from a URL-driven open and to confirm the anchor param strips after.

## Considered and rejected

- **Bare-root `/<threadId>`** (the literal first proposal) — shortest, but a
  dynamic segment at the root sits as a sibling to static `/library`/`/settings`,
  permanently claiming the root namespace and reading as a surprising route file.
  Namespacing to `/thread/$id` costs one segment and matches Library. Rejected.
- **Store stays primary, URL mirrors it** — keeps `focusedThreadId` and syncs it
  both ways. Rejected: dual-source-of-truth, and it would make the addressability
  cosmetic rather than real. See *Why URL-authority* above.
- **Anchor persists in the URL** (true deep-link that lingers) — shareable to a
  *specific Message* that stays addressable, but forces a decision on what clears
  a stale anchor (next send? thread switch? never?) and fights issue #138's
  one-shot highlight semantics. Rejected for now in favor of consume-then-strip;
  the Thread URL is the durable shareable artifact, the Message anchor a transient
  jump instruction. (Persisting the anchor is a clean future change if a
  stay-addressable Message link is ever wanted.)
- **Deep layout** (hoist composer + scroll frame into `_chat`, so even the
  composer never remounts) — marginal extra win (the composer is cleared on send
  anyway) at the cost of a route-aware composer that must inspect the path to pick
  `send` vs `sendNewThread`. Rejected: thin layout keeps `ChatColumn` cohesive
  (the component owning send semantics owns the composer). Promote later only if
  shell-internal remount ever bites.
- **Distinguish not-found from transient fetch error by auto-retry-then-notify** —
  retrying a `-32001` is guaranteed to fail again (it is deterministic, not
  transient), so an auto-retry loop buys only latency. Rejected in favor of the
  tag split: `UnknownThreadError` → not-found immediately, `WsRequestError` →
  retry. (For the first cut we ship only the not-found branch and leave the
  transient/retry path exactly as it is — "B-additive".)
- **Anchor-to-capturing-Message from a Library Entity's "source thread"** — would
  navigate to `/thread/$id?focusedMessageId=<msg>` so the user lands on the
  Message that captured the Entity. Gated on whether the provenance record
  (ADR-0030) carries a stable Message id; `created_from` records the thread/origin,
  not necessarily a Message. Deferred — the routing side is trivial, the data side
  is a separate question.
```
