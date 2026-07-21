# Deterministic skill triggers: matched-skill directive at dispatch

/ amends [ADR-0036](./0036-skills-progressive-disclosure.md)

ADR-0036 made skill selection the model's job: Core discloses `name` + `description`
in an `<available_skills>` block and the model chooses whether to call `load_skill`.
That works, but routing is only as reliable as the model's read of a description —
"let's do my weekly review" *usually* triggers a `load_skill("weekly-review")`, and
sometimes doesn't. We want the reliable half of MeshClaw's feel (talk naturally, the
right procedure is there) without giving up the trust posture ADR-0036 fought for.

## Decision

A skill may declare **trigger phrases** in its frontmatter. At **fresh dispatch**,
Core matches the current turn's prompt against the eligible scan set's trigger
phrases (exact contiguous token match, longest-phrase-wins, cap 1). On a match, Core
appends **one Core-authored directive line** to the effective `system_prompt`, right
after the closing `</available_skills>` tag:

> This request matches the `<name>` skill. Call load_skill("<name>") before
> responding and follow it, unless it is clearly inapplicable.

Only the skill **name** is interpolated — a value that already passed ADR-0036's
`eligible()` delimiter/control-char screen. Trigger text and body text are **never**
rendered into any prompt.

The stance in one line: **deterministic matching, model-mediated loading.** The match
is a pure string computation Core runs before the model; the *load* stays a real,
model-chosen `load_skill` call. The untrusted skill **body** therefore still enters
context only as ordinary `tool_result` content, exactly as ADR-0036 mandates — the
directive names a skill, it never smuggles a body.

### Why this is safe where front-loading was not

ADR-0036 rejected "Front-load the best-matching skill at dispatch" on three grounds.
This directive avoids all three:

- *"bakes the body into `system_prompt`"* → no body ever rides in `system_prompt`;
  only a Core-authored line naming a screened skill name. The body's trust class is
  unchanged (`tool_result`, via a real load).
- *"pays its full context cost on every Run whether used or not"* → the directive is
  ~30 tokens and only appears on a match; the body's full cost is paid only if the
  model actually loads it.
- *"mis-matches with no recovery"* → selection stays in the model's hands via the
  real `load_skill` round-trip, and the *"unless it is clearly inapplicable"* clause
  is the explicit recovery. Disclosure + `load_skill` remain untouched as the
  backstop for everything triggers miss.

What **remains rejected** from that alternative: any keyword/LLM matching over
*descriptions*, and any skill *body* in `system_prompt`.

### The model's veto is a deliberate retained filter

A dropped-in `SKILL.md` is untrusted (ADR-0036 §Trust). Under model-mediated loading,
the model's decision to call `load_skill` is the one runtime filter between an
untrusted body and the context. We keep it on purpose: a "zero-discretion" auto-inject
would *remove* that filter. The directive is a strong nudge in the trusted class, not
a bypass of the trust boundary.

## Frontmatter

`triggers` is added to ADR-0036's shape as an **optional** field — a YAML sequence of
phrase strings:

```yaml
---
name: weekly-review
description: >-
  Guide a GTD weekly review…
triggers:
  - weekly review
  - review my projects
---
```

- **Strict-subset argument extended.** ADR-0036 keeps the format a strict subset of
  the Agent Skills standard by ignoring unknown fields. `triggers` is one more field
  other consumers (Claude/Codex/openclaw) ignore, so community skills still drop in
  unchanged and inkstone skills still import cleanly.
- **Normalization.** Each phrase is lowercased and tokenized on non-alphanumeric
  boundaries (`char::is_alphanumeric`) into a token sequence. This is stated
  normatively: matching is over **token sequences**, never raw substrings — a future
  "match on the raw string" optimization would reintroduce a rendered-delimiter
  surface and is therefore disallowed.
- **The ≥2-token phrase floor (the single validity rule).** A phrase that normalizes
  to fewer than 2 tokens is dropped and logged (`skills.trigger_dropped`). This kills
  single-word squatting (`help`, `email`, `the`) and doubles as the empty-phrase
  guard. It drops the **phrase**, never the skill — triggers are optional
  enhancement, unlike `name`/`description` whose absence makes a skill ineligible.
- **YAML type errors drop the skill.** A malformed `triggers` value (e.g.
  `triggers: foo`, a scalar where a sequence is required) is already a serde error →
  `skills.skill_frontmatter_invalid` → the skill is skipped, identical to any other
  malformed frontmatter (ADR-0036 fail-soft posture).
- **Parsed inside the one `eligible()` gate.** A skill discovery drops (unsafe
  metadata, name mismatch, missing field) contributes no triggers — so the
  loadable, advertised, and matchable sets are the same set.

## Matching rules (normative)

- **Contiguity.** A phrase matches iff its token sequence occurs contiguously in the
  prompt's token sequence. (`weekly-review` in prose tokenizes to `["weekly",
  "review"]`, so it matches the phrase `weekly review`.)
- **Winner.** Score = token count of the longest matched phrase per skill; highest
  score wins, ties broken by scan order (already name-sorted).
- **Cap 1.** At most one directive per Run. Other matches are already advertised in
  `<available_skills>`; the block's "choose the most specific" instruction covers them.
- **Fresh dispatch only.** Matching runs in `fresh_manifest_line`, over
  `SpawnManifest.prompt` only — never prior history (a stale trigger must not re-fire
  on a follow-up) and never a resume transcript. `resume_manifest_line` re-derives the
  `<available_skills>` block live (ADR-0036 behavior) but adds **no** directive and
  runs **no** matcher.

## Trigger-squatting analysis

The threat model is ADR-0036's: a dropped-in/community `SKILL.md` is untrusted, on a
single-user machine, prompt-injection class (the attacker is the skill author).

- The ≥2-token floor removes single-word grabs.
- When a legit skill also matches, longest-phrase-wins means a specific skill beats a
  generic bigram.
- When *no* legit skill matches, a common bigram (e.g. `my email`) can still win the
  slot. This residual is **accepted** at single-user scale: the blast radius is one
  Core-authored directive line the model may veto, a visible "Loaded skill" row if it
  complies, cap 1/Run, and a file the user placed themselves. (Longest-wins does *not*
  defend the uncontested case — stated plainly rather than overclaimed.)
- The body's authority ceiling is unchanged: `tool_result` class, and every
  subsequent tool call is still validated against the allowlist
  (`tools::is_allowed`, `worker/run.rs`).

## Considered and rejected

- **Transcript fabrication (synthetic pre-completed `load_skill` pair).** Inject an
  `Assistant{tool_call: load_skill}` + `ToolResult{body}` pair into the fresh
  manifest's `messages` so the body is present with zero model discretion. Rejected —
  four verified costs: (1) on a fresh thread `skip_history: true`
  (`start_run.rs:546`) makes the injected assistant message the transcript's **first**
  message, and Anthropic requires the first role to be `user` → the Run 400s (and the
  faux-worker e2e is green, so it ships broken); (2) on resume,
  `render_result_content` replays the persisted `AgentToolResult` JSON verbatim
  (escape-soup, not markdown) and `MAX(seq)+1` positions the pair *below* the prompt —
  "snapshot semantics for free" is false; (3) the pre-spawn `RunEvent::ToolCall`
  pair is lost to the text-only `run/subscribe` snapshot, so the live UI row never
  appears; (4) persist-first leaves completed `load_skill` rows on Runs that never
  ran (cancel/token-fail). **Kept as the documented escalation path** only if the
  directive measurably fails to fire — and then only with a body-size cap added
  (the no-budget stance does not transfer from model-pulled to Core-pushed loads).
- **Fuzzy ≥70% word-overlap matching (MeshClaw).** Rejected: unpredictable at a
  handful of skills; exact contiguous phrases keep every activation explainable in
  one line, and misses fall through to the untouched disclosure + `load_skill` path.
- **`always: true` session-start pin.** Rejected: the trusted always-on slot is the
  default Workflow's `system_prompt` (Core-managed config). An `always` skill would
  either put an unscreenable body into `system_prompt` (a §Trust violation) or pay
  full body cost every Run — the exact ground ADR-0036 rejected front-loading on,
  with none of the trigger layer's conditionality. Always-on = edit the default
  workflow's `system_prompt`, no frontmatter flag.
- **`$name` explicit invocation.** Deferred, not rejected. Vetted shape recorded for
  later: a `$name` token allowlist-matched against the scanned eligible set (never
  path-derived), prompt-only input, cap ~3, dedup, preempts trigger matching. It needs
  nothing from the web client (plain text in the composer), so deferring costs no
  architectural option; ADR-0036's "user-invocable skills" deferral stands in full.
- **Negative triggers.** Rejected for v1, with **no reserved `!` syntax** (reserving
  syntax is code for a feature we don't build). If wanted later, a separate
  `negative_triggers:` field is additive by construction.
- **Usage ranking / char budget / TTL + mtime caches / bundles / curator.** Rejected:
  the whole index fits in `<available_skills>` at this scale; tier 2 already timestamps
  every `load_skill` call, so ranking telemetry exists free the day it's needed. The
  per-dispatch scan is ADR-0036's accepted design point; the single mtime-manifest
  cache ADR-0036 already reserves remains the only sanctioned future cache.
- **Inline shell (`` !`cmd` ``) / template-var preprocessing in bodies.** Rejected
  outright: a skill body is never executed (ADR-0036 §Trust); executing shell embedded
  in an untrusted body at load time is a prompt-injection→RCE bridge.

## Consequences

- **The Dispatcher still does not route on skills (ADR-0011 holds).**
  `dispatch_and_resolve` (`start_run.rs`) still ignores the prompt and returns the
  single default Workflow. Matching is manifest enrichment inside the existing spawn
  path (`fresh_manifest_line`), not a Router.
- **The worker manifest schema is unchanged (ADR-0018 holds).** The directive grows
  an existing per-spawn `system_prompt` string; `messages` is untouched — which is
  precisely what keeps the fresh-thread transcript user-first and avoids the rejected
  design's 400. No new frame kind, no new field.
- **No client-protocol change in v1.** Observability is the *existing* `load_skill`
  tool events (live `ToolActivity` row + `thread/get` rehydration) plus two tracing
  events under ADR-0038: `skills.trigger_matched {skill, phrase}` at directive
  injection and `skills.trigger_dropped {path, phrase, reason}` at scan. No `auto`
  provenance field on `RunEvent`/`Segment` — the load is a genuine model decision, so
  an "auto" badge would be false (and would be forgeable anyway).
- **One honest gap.** When the model exercises its veto (judges the directive
  inapplicable), the client shows nothing — only the tracing event records the match.
  That is the veto working as designed, not a missing surface.

## Related

- [ADR-0036](./0036-skills-progressive-disclosure.md) — the Skills subsystem this
  amends. Discovery/Disclosure/Activation/Composition and the `eligible()` gate are
  unchanged; this adds a `triggers` field and a matched-skill directive, and partially
  amends its "Front-load the best-matching skill at dispatch" rejection (above).
- [ADR-0011](./0011-per-run-workflow-dispatch.md) — Dispatcher seam. Still returns the
  single default Workflow; skills are not routed.
- [ADR-0018](./0018-workflow-and-tools-definition.md) — frozen manifest. The directive
  lives within `system_prompt`; no schema change.
- [ADR-0025](./0025-proposal-park-and-resume.md) — park/resume rebuilds from tier 2.
  The directive is fresh-dispatch-only; a skill loaded before park replays as a real
  tool call, and a Run parked before the model acted on the directive simply loses it
  (accepted).
- [ADR-0038](./0038-diagnostic-logging-trail.md) — where the `skills.trigger_matched` /
  `skills.trigger_dropped` events live.
- CONTEXT.md `Skill` — gains a line on trigger phrases.
