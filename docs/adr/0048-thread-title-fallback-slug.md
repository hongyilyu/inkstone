# Thread-title fallback is a word-boundary slug, not a prompt dump

A Thread's create-time fallback title — the name it carries until (and unless) the
one-shot titler (ADR-0046) generates a better one — is the user's first prompt
**collapsed to a single line and trimmed to the last whole word within ~32
scalars**, not the prompt **truncated to 80 scalars mid-word**. The slug is the
*acceptable permanent name* for a Thread that never gets a generated title, so no
retry/regenerate affordance is built. This **resolves-by-decline** the title
transient-failure retry affordance (issue #206 deferred item 2).

This **supersedes** the placeholder definition in
[ADR-0046](./0046-generated-thread-title.md): "the truncated-prompt title that
`thread/create` writes synchronously … truncated to 80 scalars". That 80-scalar
mid-word truncation is replaced by the word-boundary slug. The **generated**
title's 80-scalar cap (`TITLE_MAX_CHARS`, applied by `sanitize_title`) is
**retained** — only the *fallback* derivation changes.

## Context

ADR-0046 writes a synchronous fallback title at `thread/create` (the user's
first prompt, trimmed to 80 scalars) and fires a fire-and-forget non-Run
"titler" Worker that overwrites it with an LLM-generated title on success. ADR-0047
delivers that generated title live over the originating connection. But **every**
titler failure path — no credential (the strict `Ok(Some(token))` gate), no title
model, launch error, spawn error, 15s timeout, Worker `error` frame,
empty-after-sanitize, DB-write error — **silently keeps the fallback**, with no
record that generation was attempted or failed.

Issue #206 deferred item 2 asked for a **retry/regenerate affordance** so a Thread
stuck on the fallback (a transient model blip, or — common on a fresh install —
a provider connected *after* the Thread was created, so the titler never spawned)
could be re-titled. The lone cited precedent was Zed, which keeps the title unset
plus an in-memory `title_generation_failed` flag to offer a header retry button.

A source survey of eight peer tools (OpenAI Codex, opencode, t3.chat / its
open clone, Zed, Continue, Cline, Open WebUI, LibreChat) reframed the problem:

- **LLM titlers title *after the first turn*** (opencode, t3code, Zed, Continue,
  Open WebUI, LibreChat) — a point at which a provider is necessarily connected,
  so titling rarely fails. Their universal answer to a *bad* title is **manual
  rename** (8/8 have it); an LLM **regenerate** button is rare (only Open WebUI
  and Zed) and exists for *re-rolling*, not *failure recovery*.
- **The fallback is a neutral, permanent label** everywhere: `New session`
  (opencode), `New thread` (t3code), `New Chat` (Open WebUI / LibreChat),
  first-message-verbatim (Codex, Cline). None treats the un-generated state as a
  defect needing a recovery path; none persists a durable failed-vs-never bit
  (Zed's flag is in-memory, reset on DB load).

So inkstone's stuck-fallback "defect" is, in the field, simply *the default name*.
The highest-leverage fix is not a retry affordance (new wire verb, persisted
state crossing the `ThreadSummary` parity gate, a `WsClient` interface method
across ~23 test doubles, an in-flight UX with no failure-signal channel) but a
**better fallback** — a clean, identifiable label so the un-generated state reads
as a deliberate name rather than a truncated sentence fragment.

The prior 80-scalar truncation cut mid-word (`"i need to plan the q3 budget acro"`).
For a notes app whose Thread titles are scanned in a sidebar to re-find a
conversation, a word-boundary slug (`"i need to plan the q3 budget"`) is the
cheaper, more legible thing — and it is computed Core-side, so no client,
protocol, or SDK surface changes.

## Decision

- **Fallback = a word-boundary slug.** A new pure `runs::title::placeholder_title`
  collapses the prompt's internal whitespace to single spaces and trims, then
  backs off to the **last whole word** within `PLACEHOLDER_MAX_CHARS` (32)
  scalars. **No ellipsis** is appended (a generated title is a clean 3–7 words;
  the slug reads as a plain short label, not a visibly-cut one). If the **first
  word alone** exceeds the cap, it is hard-cut at the cap on a scalar boundary so
  the slug can never collapse to empty (the empty-prompt case is already rejected
  upstream with `invalid_params`).

- **One cap per role.** `PLACEHOLDER_MAX_CHARS = 32` governs the *fallback* slug;
  `TITLE_MAX_CHARS = 80` continues to govern the *generated* title in
  `sanitize_title`. They are deliberately distinct — the fallback is a terse
  identifier, the generated title is a fuller phrase.

- **No retry/regenerate, no persisted state, no rename.** The slug *is* the
  permanent name for an un-titled Thread. No `thread/regenerate_title` verb, no
  `title_generated`/`title_generation_failed` column, no `ThreadSummary` change,
  no `WsClient` method, no web/SDK change. The titler (ADR-0046) and its
  `thread/titled` live push (ADR-0047) are untouched: on success the generated
  title still overwrites the slug exactly as before.

- **Server-side only.** The slug is computed in `thread/create`; the sidebar,
  the hover tooltip, the command palette, and `run/get_history` all render
  `thread/list`'s `title` string verbatim. The sidebar tooltip now reveals the
  slug rather than the full prompt — an accepted, minor consequence.

## Considered and rejected

- **Build the retry/regenerate affordance** (issue #206 item 2 as literally
  written). Rejected as the *primary* fix: it is the field's *rare* feature
  (2/8 tools), it targets a failure mode the field rarely hits (titling happens
  post-turn, with a provider present), and it carries the heaviest cost surface
  (new verb + persisted state across the parity gate + `WsClient` method across
  ~23 doubles + an in-flight/failure UX with no existing failure-signal channel,
  since `thread/titled` fires only on success). The better fallback dissolves the
  motivating problem at a fraction of the cost.

- **Manual rename** (the field's *universal* affordance, 8/8 tools). Rejected for
  *this* change as still more than the problem needs: it adds a wire verb, a
  `WsClient` method, and inline-edit UI, and it opens a clobber race (a background
  titler overwriting a hand-typed title — the exact case Zed and t3code guard
  against). A legible fallback removes the everyday need to rename. Rename remains
  the natural, higher-precedent next step if a real need emerges — and would then
  require a "user-set title wins" rule before the titler may overwrite.

- **A neutral timestamp sentinel** (`New thread · Jun 22`), matching opencode /
  t3code / Open WebUI. Rejected: in a notes app the title's job is to *identify*
  the Thread; on a fresh install with no provider connected, *every* un-generated
  Thread would share an indistinguishable sentinel. A prompt-derived slug stays
  identifiable.

- **Append an ellipsis to a truncated slug** (`"i need to plan the q3 budget…"`).
  Rejected: the trailing `…` is a "provisional/cut" cue, but it makes a truncated
  slug visually unlike a whole short prompt for no functional gain, and a
  generated title never carries one anyway. A plain word-boundary cut is cleaner.

- **Persist a `title_generated` bit / infer it at read time** (to gate a future
  affordance). Moot once the affordance is declined; recorded here so a future
  revisit starts from "no state exists" rather than rediscovering it. No surveyed
  tool persists a durable failed-vs-never distinction.

## Related

- [ADR-0046](./0046-generated-thread-title.md) — the one-shot titler; this ADR
  supersedes its placeholder *definition* (80-scalar truncation → word-boundary
  slug) and retains its generated-title `TITLE_MAX_CHARS` cap and every failure
  path (each now keeps the *slug*).
- [ADR-0047](./0047-connection-notification-channel.md) — the live `thread/titled`
  delivery of a generated title, unchanged; a successful generation still
  overwrites the slug and pushes live.
- Issue #206 deferred item 2 (title transient-failure retry/regenerate
  affordance) — **resolved by decline**: the legible fallback makes the
  un-generated state an acceptable permanent name rather than a defect. Item 1
  (live delivery) shipped in ADR-0047; the provider-OAuth-connected notification
  and re-titling-as-the-thread-grows remain separate, still-deferred follow-ups.
