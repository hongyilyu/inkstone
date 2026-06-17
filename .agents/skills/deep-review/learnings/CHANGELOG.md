# deep-review learnings — changelog

Append-only. Each entry records what the reviewer learned and when.

## 2026-06-17 — Incremental sweep of all 3 tracked repos (inkstone + opencode + pi)

- **Source:** 91 cleaned inline review comments newer than each repo's cursor —
  `hongyilyu/inkstone` 83 (cursor → 2026-06-17T03:04:01Z), `anomalyco/opencode` 8
  (cursor → 2026-06-16T13:38:30Z), `earendil-works/pi` 1 sub-threshold one-liner, no rule
  (cursor → 2026-06-16T12:46:11Z). Reviewers: CodeRabbit, ChatGPT Codex, GitHub Copilot, humans.
- **Pipeline (`/deep-review-learn`, background Workflow):** 4 parallel miners (3 inkstone chunks +
  1 opencode) classified each comment vs the 285-rule digest → 21 candidates · 23 reinforcements ·
  38 noise → per-candidate adversarial verification.
- **Result:** **18 new rules added** (14 from inkstone, 4 from opencode), **18 existing rules
  reinforced** (support_count bumped, PRs added; the 23 reinforcement comments collapsed onto 18
  distinct rules), **3 candidates dropped in verification** — two on fabricated/inaccurate evidence
  (a `key=` reset bug that the code already guarded; a build-path invariant whose claimed fix never
  shipped), one a by-design decision the team already resolved against (omit-vs-null agent-schema
  clear).
- **KB grew 285 → 303 rules.** New-rule mix: 15 important · 2 blocking · 1 nit. Heaviest new
  coverage: correctness +6, testing +3, error-handling +2, security +2, ui-react +2.
- **Notable new lessons:**
  - *Bound a computed value at the producer to the downstream validator's range* — an out-of-range
    year/length/id rejected by a strict validator inside an enclosing tx rolls back the whole write
    instead of gracefully no-oping (`correctness`, blocking).
  - *In a three-way merge where absent = preserve, emit explicit null to clear* — `delete obj.key`
    does NOT clear a stored field under partial-merge semantics; it leaves stale data that violates
    downstream invariants (`data-persistence`).
  - *Salvage a correlation/id field before strict decode* — capture the id that lets you record a
    terminal/error outcome before the parse that may fail, or recovery can't attribute the failure
    (`error-handling`).
  - *Optional observability-subsystem init must fail open* — logging/metrics/tracing setup must not
    abort boot of the primary service when it fails (`error-handling`).
  - *Prefer an args array over an interpolated shell-command string for subprocesses* — `execSync(\`t
    ${x}\`)` is a quoting bug and a command-injection vector; use execFile/spawn with `[args]`
    (`security`).
  - *Don't run synchronous blocking calls on the event-loop/UI thread* — swapping async spawn for
    execSync freezes a TUI/GUI for the subprocess duration (`performance`).
  - *Call preventDefault before the first await in an owning event handler* — an await before the
    suppression lets the platform default fire during the gap, duplicating the action (`ui-react`).
  - *A by-name lookup must reapply the listing eligibility filter* — resolving an entity directly by
    name/id must pass the same gate as discovery, or it leaks records the listing hides (`security`).
- KB regenerated: `rules.json` (v4 → v5), `INDEX.md`, `by-category/*.md`. Cursors advanced
  per source in `state.json`.

## 2026-06-15 — Incremental sweep of all 3 tracked repos (opencode + inkstone + pi)

- **Source:** 133 cleaned inline review comments newer than each repo's cursor —
  `anomalyco/opencode` 51 (cursor → 2026-06-14T15:39:45Z), `hongyilyu/inkstone` 81
  (cursor → 2026-06-15T02:06:51Z), `earendil-works/pi` 1 (cursor → 2026-06-13T09:46:01Z).
  Reviewers: CodeRabbit, ChatGPT Codex, GitHub Copilot, humans.
- **Pipeline (`/deep-review-learn`, background Workflow):** 12 parallel miners → 132 insights
  (33 new-lesson · 50 already-covered · 49 noise) → cross-chunk synthesis (29 candidates) →
  per-candidate adversarial verification.
- **Result:** **17 new rules added** (7 from opencode, 10 from inkstone), **38 existing rules
  reinforced** (support_count bumped, PRs added as evidence), **12 candidates dropped in
  verification** (fabricated/misattributed provenance, premise-false lessons, linter-caught,
  or duplicates of existing rules).
- **KB grew 268 → 285 rules.** New-rule mix: 15 important · 2 nit · 0 blocking. Heaviest new
  coverage: ui-react +4, correctness +4, data-persistence +3, performance +2.
- **Notable new lessons:**
  - *argv flag-presence checks must also match the `--flag=value` form* — `argv.includes("--flag")`
    silently misses the inline-value form when the parser honors it (`correctness`).
  - *Compare dotted version strings componentwise, not via parseFloat* — `parseFloat("5.10") === 5.1`
    collapses the minor, so "5.10" sorts before "5.4" (`correctness`).
  - *Edit-type-dispatched save must carry all edited fields* — a save keyed on edit type must not
    drop fields the user changed (`data-persistence`).
  - *Validate both referents before an FK insert* — reject blank/dangling reference ids at
    validation, not at the DB error (`error-handling`).
  - *A LIKE escape clause disables the FTS5 trigram index* — `LIKE … ESCAPE` forces a scan;
    push the filter into the FTS query (`performance`).
  - *Drain buffered stream events before interrupting on cancel* — cancellation must flush
    in-flight deltas, not drop them (`concurrency-async`).
  - *Treat an empty env var as unset for a path base* — `""` must fall back to the default,
    not resolve against the process cwd (`correctness`).
  - *Disable pointer events on interactive handles when their panel is collapsed* — focus/tab
    order (rule #196) isn't enough; a zero-size handle still captures clicks (`ui-react`).
- KB regenerated: `rules.json` (v3 → v4), `INDEX.md`, `by-category/*.md`. Cursors advanced
  per source in `state.json`.

## 2026-06-12 — Bootstrap from anomalyco/opencode PR review history

- **Source:** 541 cleaned inline review comments across 180 PRs (reviewers: Copilot,
  github-actions bot, and humans incl. kitlangton, Hona, HaleTom, thdxr).
- **Pipeline:** 14 parallel miners → 374 structured insights → per-category synthesis →
  adversarial skeptic verification.
- **Result:** **148 canonical rules** kept, 34 dropped in verification (repo-specific /
  linter-caught / vague). 19 blocking · 105 important · 24 nit.
- **Coverage:** correctness 36, ui-react 22, code-quality 16, error-handling 15, testing 11,
  performance 9, security 9, data-persistence 8, concurrency-async 8, types 6, api-compat 5,
  resource-leak 3.
- Knowledge base generated: `rules.json` (source of truth), `INDEX.md`, `by-category/*.md`.

## 2026-06-12 — Learn from hongyilyu/inkstone PR reviews (CodeRabbit + Codex + human)

- **Source:** 122 cleaned inline review comments across 55 PRs of `hongyilyu/inkstone`
  (a Rust + TypeScript/Solid app). Reviewers: CodeRabbit (61), ChatGPT Codex (53), human/hongyilyu (8).
- **Pipeline (`/deep-review-learn`):** 6 miners → 105 insights → gap analysis vs the existing
  148-rule KB → adversarial verification of new candidates.
- **Result:** **70 new rules added** (all 70 candidates survived verification), **23 existing rules
  reinforced** (support_count bumped, inkstone PRs added as evidence), 3 comments discarded as noise.
- **KB grew 148 → 218 rules.** New-rule mix: 50 important · 15 nit · 5 blocking. Heaviest new
  coverage: testing +15, data-persistence +10, ui-react +9, correctness +8, code-quality +7.
- **Notable new lessons** (Rust + TS, beyond the opencode bootstrap):
  - *Lazy singleton init must be atomic* — SELECT-then-INSERT on the pool races; use
    `INSERT … ON CONFLICT DO NOTHING` or a txn (`concurrency-async`, blocking).
  - *Pin update/delete to the reviewed proposal target, not the edited payload id* — prevents an
    edited payload retargeting a mutation away from what was reviewed (`security`, blocking).
  - *Persist a terminal status on every run outcome* — forwarding live events ≠ DB persistence;
    success/error/failed-spawn/rollback must all write back, and recovery queries must still see it
    (`data-persistence`).
  - *Advertised JSON/tool schema must enumerate every backend dispatch variant & constraint* —
    schema looser than the validator deadlocks requests; stricter hides dead variants (`api-compat`).
  - *Partial-update validators must not require create-only fields*; *reject blank reference ids at
    validation* rather than treating `""` as absent (`correctness`).
  - *Strip all addressing/transport-only fields before persisting the canonical snapshot* — else
    provenance keys pollute stored rows (`data-persistence`).
  - Plus a strong **testing** cluster from CodeRabbit: assert the actual value not string-containment,
    assert the claimed-but-untested case, verify parsed JSON shape over substring checks.
- Backup of pre-merge rules at `rules.json.bak`.

## 2026-06-12 — Onboard earendil-works/pi (`learn earendil-works/pi`, full history)

- **Source:** 358 cleaned inline review comments across 123 PRs of `earendil-works/pi`
  (a large TypeScript TUI/CLI app). Reviewers: GitHub Copilot (114) + human maintainers
  (badlogic the lead, mitsuhiko, and others).
- **Pipeline:** 8 miners → 179 insights → gap analysis vs the existing 218-rule KB →
  adversarial verification.
- **Result:** **50 new rules added** (57 candidates, 7 dropped in verification), **52 existing rules
  reinforced** (cross-repo confirmation of opencode/inkstone lessons), 17 comments discarded as noise.
- **KB grew 218 → 268 rules.** New-rule mix: heavy on correctness, security, and TUI/CLI specifics.
- **Notable new lessons** (TUI/CLI + TS, beyond prior repos):
  - *No direct `console.*` in code reachable under an interactive TUI* — stdout writes corrupt the
    rendered frame; route through the UI/notify context (`code-quality`, blocking).
  - *Strip control chars from untrusted input before terminal escape sequences* — OSC-8 hyperlink /
    SGR injection from markdown hrefs or subprocess stdout (`security`, blocking).
  - *Default network servers to loopback unless auth is enforced before non-loopback bind* — don't
    default `0.0.0.0` while auth is gated on an optional token (`security`, blocking).
  - *Hand-rolled shell tokenizers must honor backslash-escape & single-quote semantics* — POSIX
    quoting edge cases; redirect-normalization regex pitfalls (`correctness`, blocking).
  - *Substitute a text placeholder when stripping image blocks* — many LLM providers reject an empty
    content array (`correctness`, blocking).
  - *Reload/refresh must reproduce all relevant startup side effects* — partial reloads leave the
    runtime half-updated (`correctness`, blocking).
  - *Bound untrusted base64 before decode*; *clone objects to the depth actually mutated*;
    *verify hardcoded external API limits against docs with a source comment* (`correctness`/`security`).
- The high reinforced count (52) shows the KB generalizing: pi's reviewers independently flagged many
  lessons already learned from opencode/inkstone. Backup at `rules.json.bak`.

