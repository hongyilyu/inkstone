# deep-review learnings — changelog

Append-only. Each entry records what the reviewer learned and when.

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

