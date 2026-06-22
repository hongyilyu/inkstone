# Inkstone — Feature Inventory & QA Tracker
> **Canonical single source of truth** for the feature-audit goal. Generated from a 12-area code read (197 user stories) + a completeness-critic pass (6 surfaces). Companion machine-readable export: [`feature-inventory.csv`](./feature-inventory.csv).

## How to read this

Each row is one user-facing feature/behavior expressed as a user story with **code-grounded acceptance criteria**. Columns:

- **Impl status** — judged from *reading the code only* (Phase 1):
  - 🟢 **impl** · 🟡 **partial** · 🔵 **stub/mock** (mock-backed or unmounted) · ⚪ **gap** (critic-found surface)
- **Test result (Phase 2)** — ✅ pass · ❌ fail · ⚠️ issue · ▢ verify (no automated coverage; audited separately).
- **Notes** — Phase-2 findings & Phase-3 fixes.

## Phase 2 — automated test baseline (2026-06-21)

Every automated suite in the repo is **green**, so every story with existing coverage is confirmed working:

| Suite | Result |
|---|---|
| Web + packages unit (vitest) | **918 passed**, 0 failed (web 659 · worker 70 · protocol 83 · contract 92 · ui-sdk 14) |
| Core (`cargo test`) | **all passed**, 0 failed (385 unit + integration binaries) |
| E2e (real Core+Worker+headless Chromium) | **120 passed**, 0 failed, 0 skipped (all 59 spec files) |

**Coverage:** 175/203 features are exercised by a green automated test (✅). The remaining 28 have no automated test and are verified by the separate UX/logistical audit (see *Audit findings* section, appended after the audit completes).

**Phase 1 impl totals:** 203 features across 13 areas — 191 impl, 6 gap, 3 partial, 3 stub/mock.

## Master status table

| ID | Area | Feature | Impl | Existing tests | Test result | Notes |
|----|------|---------|------|----------------|-------------|-------|
| F001 | Chat & Messaging | Compose and send a message into the focused thread | 🟢 impl | tests/e2e/src/interpreter-chat.spec.ts (sends, asserts s | ✅ pass | |
| F002 | Chat & Messaging | First message on the welcome screen mints a new thread | 🟢 impl | tests/e2e/src/chat-surface.spec.ts ('replaces the welcom | ✅ pass | |
| F003 | Chat & Messaging | Watch the assistant's reply stream in token-by-token | 🟢 impl | tests/e2e/src/chat-markdown.spec.ts ('streaming render' | ✅ pass | |
| F004 | Chat & Messaging | See an assistant turn's pieces (text, tool activity, proposal) in chronological order | 🟢 impl | tests/e2e/src/segment-timeline-reload.spec.ts (pill-abov | ✅ pass | |
| F005 | Chat & Messaging | Read assistant replies as formatted markdown | 🟢 impl | tests/e2e/src/chat-markdown.spec.ts ('assistant markdown | ✅ pass | |
| F006 | Chat & Messaging | See a typing indicator before the assistant's first text arrives | 🟢 impl | tests/e2e/src/chat-markdown.spec.ts (asserts indicator A | ✅ pass | |
| F007 | Chat & Messaging | Copy a completed assistant reply to the clipboard | 🟢 impl | tests/e2e/src/chat-markdown.spec.ts ('copy button' descr | ✅ pass | |
| F008 | Chat & Messaging | Stop a running or parked assistant turn from the composer | 🟢 impl | tests/e2e/src/run-cancel-ui.spec.ts; tests/e2e/src/page- | ✅ pass | |
| F009 | Chat & Messaging | See model/effort pickers and disabled Search/Attach in the composer | 🟡 partial | apps/web/src/components/ComposeFooter.test.tsx | ✅ pass | |
| F010 | Chat & Messaging | Land on a first-run welcome that teaches the chat→Library loop | 🟢 impl | tests/e2e/src/chat-surface.spec.ts ('opens with the firs | ✅ pass | |
| F011 | Chat & Messaging | See loading, recoverable-error, and not-found states when opening a thread | 🟢 impl | No dedicated chat-* e2e found; covered indirectly by tes | ✅ pass | |
| F012 | Chat & Messaging | Reload mid-stream and resume the partial reply to completion | 🟢 impl | tests/e2e/src/reload-mid-stream.spec.ts ('reload mid-str | ✅ pass | |
| F013 | Chat & Messaging | Keep a reply streaming while I navigate to another thread | 🟢 impl | tests/e2e/src/background-stream.spec.ts ('a background R | ✅ pass | |
| F014 | Chat & Messaging | Retry a stopped or failed assistant reply | 🟢 impl | tests/e2e/src/run-cancel-ui.spec.ts (asserts the assista | ✅ pass | |
| F015 | Chat & Messaging | Land at the latest message on load and jump to a searched message | 🟢 impl | tests/e2e/src/scroll-to-message.spec.ts; tests/e2e/src/m | ✅ pass | |
| F016 | Chat & Messaging | Assistant action buttons component (mock-only, not wired into the live chat) | 🔵 stub/mock | none | ▢ verify | |
| F017 | Chat & Messaging | composer-keyboard-send-and-newline | ⚪ gap | none | ▢ verify | |
| F018 | Threads | Create a new thread by sending a first message | 🟢 impl | tests/e2e/src/thread-routing.spec.ts:24-36 ("a first sen | ✅ pass | |
| F019 | Threads | Auto-derive a thread title from the first prompt | 🟢 impl | No direct title-truncation e2e; tests/e2e/src/scroll-to- | ✅ pass | |
| F020 | Threads | See all my threads listed in the sidebar | 🟢 impl | none | ▢ verify | |
| F021 | Threads | See threads grouped by recency in the sidebar | 🟢 impl | none | ▢ verify | |
| F022 | Threads | Open a thread by clicking it in the sidebar | 🟢 impl | none | ▢ verify | |
| F023 | Threads | Copy a thread's id from the sidebar | 🟢 impl | none | ▢ verify | |
| F024 | Threads | Start a new chat from the sidebar | 🟢 impl | tests/e2e/src/thread-routing.spec.ts:90-100 ("New Chat r | ✅ pass | |
| F025 | Threads | Load a thread's full message history when opened | 🟢 impl | tests/e2e/src/thread-routing.spec.ts:38-55 (reload cold- | ✅ pass | |
| F026 | Threads | Have each thread live at its own URL | 🟢 impl | tests/e2e/src/thread-routing.spec.ts:24-36 (id in URL af | ✅ pass | |
| F027 | Threads | Survive a page reload on a thread | 🟢 impl | tests/e2e/src/thread-routing.spec.ts:38-55 (reload cold- | ✅ pass | |
| F028 | Threads | Jump to a specific message via a deep link | 🟢 impl | tests/e2e/src/scroll-to-message.spec.ts:52-102 (⌘K hit d | ✅ pass | |
| F029 | Threads | Strip the message anchor from the URL after jumping | 🟢 impl | tests/e2e/src/scroll-to-message.spec.ts:99-102 (anchor s | ✅ pass | |
| F030 | Threads | See an honest not-found state for a missing or malformed thread URL | 🟢 impl | tests/e2e/src/thread-not-found.spec.ts:18-35 (unknown UU | ✅ pass | |
| F031 | Threads | Recover from a transient failure loading a thread | 🟢 impl | none | ▢ verify | |
| F032 | Threads | Open a thread from the recent-runs rail | 🟢 impl | none | ▢ verify | |
| F033 | Proposals (lifecycle) | Agent submits a Workspace mutation as a Proposal | 🟢 impl | proposal-review.spec.ts (renders a pending Journal Entry | ✅ pass | |
| F034 | Proposals (lifecycle) | A pending Proposal parks the Run and tears the Worker down | 🟢 impl | crates/core/src/worker/run.rs::proposal_request_parks_wi | ✅ pass | |
| F035 | Proposals (lifecycle) | Subscribers are notified the moment a Proposal parks | 🟢 impl | reconnect-parked.spec.ts (reopening a parked Run rehydra | ✅ pass | |
| F036 | Proposals (lifecycle) | Fetch a parked Run's pending Proposal | 🟢 impl | crates/core/tests/proposal_review_context.rs; reconnect- | ✅ pass | |
| F037 | Proposals (lifecycle) | Accept a Proposal applies the mutation and resumes the Run | 🟢 impl | crates/core/src/decide.rs::accept_applies_once_and_resum | ✅ pass | |
| F038 | Proposals (lifecycle) | Reject a Proposal declines it and resumes conversationally | 🟢 impl | crates/core/src/decide.rs::reject_resolves_without_apply | ✅ pass | |
| F039 | Proposals (lifecycle) | Edit a Proposal applies my override in one step | 🟢 impl | crates/core/src/decide.rs::edit_applies_edited_payload_a | ✅ pass | |
| F040 | Proposals (lifecycle) | A retried decide with the same key returns the prior result without re-applying | 🟢 impl | crates/core/src/decide.rs::same_key_replay_returns_prior | ✅ pass | |
| F041 | Proposals (lifecycle) | A resume that fails after a committed decision recovers on a later decide | 🟢 impl | crates/core/src/decide.rs::resume_failure_leaves_run_par | ✅ pass | |
| F042 | Proposals (lifecycle) | A stale or lost decide is reported not-decidable, not applied twice | 🟢 impl | crates/core/src/decide.rs::stale_decide_after_concurrent | ✅ pass | |
| F043 | Proposals (lifecycle) | Deleting a Proposal's target before deciding resolves the Run cleanly | 🟢 impl | crates/core/src/decide.rs::accept_with_deleted_gtd_targe | ✅ pass | |
| F044 | Proposals (lifecycle) | After a decision the Run resumes from the Decision as the awaited tool result | 🟢 impl | proposal-review.spec.ts (accept/edit/reject all resume t | ✅ pass | |
| F045 | Proposals (lifecycle) | A parked Proposal survives a Core restart and stays decidable | 🟢 impl | crates/core/tests/proposal_restart.rs; reconnect-parked. | ✅ pass | |
| F046 | Proposals (lifecycle) | A decided Proposal card survives a page reload | 🟢 impl | proposal-decided-reload.spec.ts (decided card survives r | ✅ pass | |
| F047 | Proposals (lifecycle) | Cancelling a parked Run clears its pending Proposal | 🟢 impl | run-cancel-parked.spec.ts (clicking Stop cancels a parke | ✅ pass | |
| F048 | Proposals (lifecycle) | Auto-approve is a Core seam that currently approves nothing | 🟡 partial | none | ▢ verify | |
| F049 | Proposal Card UI | Proposal card dispatches single-entity vs intent-graph review | 🟢 impl | e2e proposal-captured-response.spec.ts (journal create c | ✅ pass | |
| F050 | Proposal Card UI | Unrecognized proposal kind degrades to a safe fallback view | 🟢 impl | none | ▢ verify | |
| F051 | Proposal Card UI | Journal create/update/delete render mode-specific diff bodies | 🟢 impl | e2e proposal-captured-response.spec.ts (asserts body tex | ✅ pass | |
| F052 | Proposal Card UI | Person/Project/Todo proposals render their detail bodies | 🟢 impl | none | ▢ verify | |
| F053 | Proposal Card UI | Accept and reject a single-entity proposal with per-kind labels and busy states | 🟢 impl | e2e proposal-captured-response.spec.ts, mutation-descrip | ✅ pass | |
| F054 | Proposal Card UI | Journal accept/save is gated on payload validity with inline error copy | 🟢 impl | none | ▢ verify | |
| F055 | Proposal Card UI | Inline Edit affordance shown only for editable kinds | 🟢 impl | e2e mutation-descriptor-verify.spec.ts (edit on create_j | ✅ pass | |
| F056 | Proposal Card UI | Inline-edit a journal-entry proposal before accepting | 🟢 impl | e2e mutation-descriptor-verify.spec.ts ('edit changes th | ✅ pass | |
| F057 | Proposal Card UI | Inline-edit GTD create proposals (Todo/Person/Project) via the deep GtdEditForm | 🟢 impl | e2e proposal-edit-todo.spec.ts (edit a create_todo title | ✅ pass | |
| F058 | Proposal Card UI | GTD edit overlays preserve unsurfaced fields and omit blank optionals (create/full-replace) | 🟢 impl | unit proposalEdit.test.ts | ✅ pass | |
| F059 | Proposal Card UI | Editing an update_todo proposal edits the partial in place (omit-vs-sentinel split) | 🟢 impl | unit proposalEdit.test.ts | ✅ pass | |
| F060 | Proposal Card UI | A failed decide surfaces an error and re-issues the same decision on retry | 🟢 impl | none | ▢ verify | |
| F061 | Proposal Card UI | A decided proposal collapses to an Applied/dismissed pill with entity name + Library link | 🟢 impl | e2e proposal-decided-reload.spec.ts (asserts 'added to j | ✅ pass | |
| F062 | Proposal Card UI | A decided proposal's outcome survives a page reload | 🟢 impl | e2e proposal-decided-reload.spec.ts (accepts a journal p | ✅ pass | |
| F063 | Proposal Card UI | Intent-graph proposal renders a node-by-node review queue | 🟢 impl | e2e intent-graph-review.spec.ts ('accept-all commit land | ✅ pass | |
| F064 | Proposal Card UI | Ambiguous graph nodes are reject-only and block accept-all | 🟢 impl | unit intentGraphReview.test.ts; not exercised by the e2e | ✅ pass | |
| F065 | Proposal Card UI | Inline-edit a create node's recognition fields before applying | 🟢 impl | e2e intent-graph-review.spec.ts ('editing a create node | ✅ pass | |
| F066 | Proposal Card UI | Near-match create nodes default to reusing the existing entity with an escape hatch | 🟢 impl | e2e intent-graph-review.spec.ts ('a near-twin Project de | ✅ pass | |
| F067 | Proposal Card UI | Rejecting a graph target a Todo links to surfaces a downgrade notice before Apply | 🟢 impl | e2e intent-graph-review.spec.ts ('rejecting the Project | ✅ pass | |
| F068 | Proposal Card UI | Apply commits the staged graph as one decision vector; Dismiss all rejects everything | 🟢 impl | e2e intent-graph-review.spec.ts (all four tests: 'apply | ✅ pass | |
| F069 | Proposal Card UI | Graph staging resets when the proposal identity changes within a reused card | 🟢 impl | none | ▢ verify | |
| F070 | Library / Entity CRUD | Browse the Library nav: chat return, search, GTD views, and per-kind collections with counts | 🟢 impl | none | ▢ verify | |
| F071 | Library / Entity CRUD | Browse a per-kind collection list with kind-specific sorting and live count | 🟢 impl | tests/e2e/src/library-crud.spec.ts (asserts collection r | ✅ pass | |
| F072 | Library / Entity CRUD | Search/filter items within a collection | 🟢 impl | none | ▢ verify | |
| F073 | Library / Entity CRUD | See a loading skeleton while a collection loads | 🟢 impl | none | ▢ verify | |
| F074 | Library / Entity CRUD | See teaching empty states and a load-error state | 🟢 impl | tests/e2e/src/library-live-only.spec.ts:25 (Today empty | ✅ pass | |
| F075 | Library / Entity CRUD | Recognize each item by its glyph and row (kind by glyph+label, never colour alone) | 🟢 impl | apps/web/src/components/library/EntityRow.test.tsx; Enti | ✅ pass | |
| F076 | Library / Entity CRUD | View an entity's detail inspector with relations as deep links | 🟢 impl | apps/web/src/components/library/EntityDetail.test.tsx; t | ✅ pass | |
| F077 | Library / Entity CRUD | Follow an entity's 'Captured from' provenance footer to its source | 🟢 impl | tests/e2e/src/entity-provenance.spec.ts (extract→follow | ✅ pass | |
| F078 | Library / Entity CRUD | Create a Todo directly from the Library rail | 🟢 impl | tests/e2e/src/library-crud.spec.ts:18 (create a Todo via | ✅ pass | |
| F079 | Library / Entity CRUD | Edit a Todo via the inspector (partial-diff update with sentinel-null clears) | 🟢 impl | tests/e2e/src/library-crud.spec.ts:49 (edit Todo persist | ✅ pass | |
| F080 | Library / Entity CRUD | Create and edit a Person directly (full-document replace) | 🟢 impl | tests/e2e/src/library-crud.spec.ts:188 (edit Person full | ✅ pass | |
| F081 | Library / Entity CRUD | Create and edit a Project directly (full-replace with verbatim-data overlay) | 🟢 impl | tests/e2e/src/library-crud.spec.ts:240 (edit status→on_h | ✅ pass | |
| F082 | Library / Entity CRUD | Create and edit a Journal Entry directly (full-replace body + reference weave) | 🟢 impl | tests/e2e/src/library-crud.spec.ts:355 (edit then delete | ✅ pass | |
| F083 | Library / Entity CRUD | Create and edit a Bookmark directly (ADR-0036, user-only kind) | 🟢 impl | tests/e2e/src/library-crud.spec.ts:412 (create), :443 (e | ✅ pass | |
| F084 | Library / Entity CRUD | Delete any entity via a two-step inline confirm | 🟢 impl | tests/e2e/src/library-crud.spec.ts:102 (delete Person), | ✅ pass | |
| F085 | Library / Entity CRUD | Receive validation errors on an invalid entity write without partial state | 🟢 impl | crates/core/src/entities.rs validate unit tests (reject | ✅ pass | |
| F086 | Library / Entity CRUD | Library reads live entities per kind via entity/list | 🟢 impl | tests/e2e/src/library-live-only.spec.ts (live-only reads | ✅ pass | |
| F087 | Library / Entity CRUD | Only manually-creatable kinds expose a 'New' affordance | 🟢 impl | tests/e2e/src/library-crud.spec.ts (New Todo / New Bookm | ✅ pass | |
| F088 | GTD Views | Inbox shows only active, unorganized todos | 🟢 impl | tests/e2e/src/gtd-views.spec.ts ('GTD views derive Inbox | ✅ pass | |
| F089 | GTD Views | Waiting view shows active todos with a waiting_on person ref | 🟢 impl | tests/e2e/src/gtd-views.spec.ts asserts Waiting includes | ✅ pass | |
| F090 | GTD Views | Project Review lists active/on-hold projects whose review is due | 🟢 impl | tests/e2e/src/gtd-views.spec.ts asserts 'API migration' | ✅ pass | |
| F091 | GTD Views | Review queue is a stable session snapshot that doesn't reshuffle mid-review | 🟢 impl | project-review.spec.ts ('mark a due project reviewed' an | ✅ pass | |
| F092 | GTD Views | Mark a project reviewed advances its review schedule | 🟢 impl | tests/e2e/src/project-review.spec.ts ('mark a due projec | ✅ pass | |
| F093 | GTD Views | Mark reviewed is rejected for completed/dropped projects | 🟢 impl | crates/core/src/mutate.rs unit tests (mark_project_revie | ✅ pass | |
| F094 | GTD Views | Focused review shows cadence, last-reviewed date, and a project counter | 🟢 impl | tests/e2e/src/project-review.spec.ts ('focused review qu | ✅ pass | |
| F095 | GTD Views | Step forward and back through the review queue | 🟢 impl | tests/e2e/src/project-review.spec.ts ('focused review qu | ✅ pass | |
| F096 | GTD Views | Complete a project's next-action todo inline during review | 🟢 impl | tests/e2e/src/project-review.spec.ts ('focused review qu | ✅ pass | |
| F097 | GTD Views | Today highlights todos due soon, overdue first | 🟢 impl | today-overview.spec.ts covers header/In focus/Recently c | ✅ pass | |
| F098 | GTD Views | Today shows in-focus projects with progress and recently captured items | 🟢 impl | today-overview.spec.ts ('Today renders its header and th | ✅ pass | |
| F099 | GTD Views | Selecting an item on Today opens its detail rail without leaving | 🟢 impl | today-overview.spec.ts ('selecting an entity on Today op | ✅ pass | |
| F100 | GTD Views | Derived todo views handle loading, error, selection, and live count | 🟢 impl | Loading/error/empty states have no dedicated e2e; the po | ✅ pass | |
| F101 | GTD Views | Todo person references (role waiting_on/related) ride on the todo and drive views | 🟢 impl | tests/e2e/src/gtd-views.spec.ts asserts the Todo detail | ✅ pass | |
| F102 | GTD Views | A todo's owning project is derived from project_id and shown in detail/rows | 🟢 impl | tests/e2e/src/gtd-views.spec.ts asserts the Todo detail | ✅ pass | |
| F103 | GTD Views | Completing a todo transitions it to completed and removes it from active views | 🟢 impl | tests/e2e/src/project-review.spec.ts asserts an inline c | ✅ pass | |
| F104 | GTD Views | Completing a recurring todo spawns its next occurrence | 🟢 impl | crates/core/src/recurrence.rs unit tests (advances_each_ | ✅ pass | |
| F105 | GTD Views | Project status (active/on_hold/completed/dropped) gates which projects surface | 🟢 impl | Active-status gating is exercised via today-overview.spe | ✅ pass | |
| F106 | Todo Recurrence | Define a recurrence rule on a Todo via the Library rail editor | 🟢 impl | tests/e2e/src/todo-recurrence.spec.ts (create a recurrin | ✅ pass | |
| F107 | Todo Recurrence | Editor blocks save when the chosen anchor's date is absent | 🟢 impl | none | ▢ verify | |
| F108 | Todo Recurrence | Editor blocks save on a non-positive-integer interval | 🟢 impl | none | ▢ verify | |
| F109 | Todo Recurrence | Edit or clear an existing Todo's recurrence rule | 🟢 impl | none | ▢ verify | |
| F110 | Todo Recurrence | See a recurring Todo's cadence on its detail panel | 🟢 impl | tests/e2e/src/todo-recurrence.spec.ts asserts the detail | ✅ pass | |
| F111 | Todo Recurrence | Core validates the recurrence rule structure | 🟢 impl | crates/core/src/tools/propose_workspace_mutation.rs:539 | ✅ pass | |
| F112 | Todo Recurrence | Core enforces that the anchor's date is present on the whole Todo | 🟢 impl | none | ▢ verify | |
| F113 | Todo Recurrence | Completing a recurring Todo spawns its next occurrence atomically | 🟢 impl | tests/e2e/src/todo-recurrence-generation.spec.ts (comple | ✅ pass | |
| F114 | Todo Recurrence | The successor's anchor date advances by interval x unit (naive civil math) | 🟢 impl | crates/core/src/recurrence.rs tests (advances_each_unit, | ✅ pass | |
| F115 | Todo Recurrence | Defer and due dates both advance, preserving their gap | 🟢 impl | crates/core/src/recurrence.rs tests (both_dates_advance_ | ✅ pass | |
| F116 | Todo Recurrence | A repeat stops at its 'until' end bound | 🟢 impl | crates/core/src/recurrence.rs tests (until_inclusive_bou | ✅ pass | |
| F117 | Todo Recurrence | A repeat stops after a fixed number of occurrences (after_count) | 🟢 impl | crates/core/src/recurrence.rs tests (after_count_counts_ | ✅ pass | |
| F118 | Todo Recurrence | The successor carries title/note/project, rule, and all person refs forward | 🟢 impl | tests/e2e/src/todo-recurrence-generation.spec.ts asserts | ✅ pass | |
| F119 | Todo Recurrence | A finished or non-recurring completion spawns no successor | 🟢 impl | crates/core/src/recurrence.rs end-condition tests; apply | ✅ pass | |
| F120 | Todo Recurrence | The agent proposes a recurring Todo that applies on accept | 🟢 impl | tests/e2e/src/proposal-recurring-todo.spec.ts (agent-pro | ✅ pass | |
| F121 | Todo Recurrence | The end condition (until / after_count) is persisted by Core but not editable in the UI | 🟡 partial | none | ▢ verify | |
| F122 | Search & Command Palette | Open and close the command palette via keyboard or sidebar | 🟢 impl | command-palette.spec.ts: 'opens via the ⌘K shortcut and | ✅ pass | |
| F123 | Search & Command Palette | Filter recent threads by title in the palette | 🟢 impl | command-palette.spec.ts: 'filters live Threads and Libra | ✅ pass | |
| F124 | Search & Command Palette | Filter Library entities (people, projects, todos) by title/subtitle in the palette | 🟢 impl | command-palette.spec.ts: 'filters live Threads and Libra | ✅ pass | |
| F125 | Search & Command Palette | Find conversations by message body text in the palette (Messages group) | 🟢 impl | message-search.spec.ts: '⌘K finds a message by a body su | ✅ pass | |
| F126 | Search & Command Palette | Navigate and activate results with the keyboard | 🟢 impl | command-palette.spec.ts: 'keyboard Enter on a Thread res | ✅ pass | |
| F127 | Search & Command Palette | See an empty-state prompt and a no-match message instead of a blank palette | 🟢 impl | command-palette.spec.ts: 'teaches a no-match instead of | ✅ pass | |
| F128 | Search & Command Palette | Activate a Thread result to navigate to that conversation | 🟢 impl | command-palette.spec.ts: 'keyboard Enter on a Thread res | ✅ pass | |
| F129 | Search & Command Palette | Activate a message hit to deep-link, scroll to, and highlight the exact message | 🟢 impl | scroll-to-message.spec.ts: '⌘K message hit deep-links to | ✅ pass | |
| F130 | Search & Command Palette | A stale or unknown focusedMessageId strips itself without wedging the thread | 🟢 impl | scroll-to-message.spec.ts: 'a stale ?focusedMessageId (n | ✅ pass | |
| F131 | Search & Command Palette | Message search returns case-insensitive substring matches over completed messages, newest-first | 🟢 impl | message_fts.rs tests: search_finds_user_message_by_subst | ✅ pass | |
| F132 | Search & Command Palette | Message search treats LIKE wildcards as literal text and rejects blank queries | 🟢 impl | message_fts.rs tests: search_treats_like_wildcards_as_li | ✅ pass | |
| F133 | Search & Command Palette | Message search returns a context snippet around the first match, byte-safe over Unicode | 🟢 impl | message_fts.rs tests: search_snippet_survives_multibyte_ | ✅ pass | |
| F134 | Search & Command Palette | Message search index self-heals and backfills on every workspace open | 🟢 impl | message_fts.rs test: rebuild_reconstructs_index_from_mes | ✅ pass | |
| F135 | Search & Command Palette | Reusable search field with leading icon, variants, and optional clear button | 🟢 impl | Exercised indirectly via command-palette.spec.ts (input/ | ✅ pass | |
| F136 | Search & Command Palette | Agent capability: search accepted People/Projects/Todos via the search_entities tool | 🟢 impl | search_entities.rs tests: person_search_matches_name_and | ✅ pass | |
| F137 | Search & Command Palette | message/search wire contract is mirrored and contract-tested across Rust and TypeScript | 🟢 impl | protocol.rs contract/serialization tests (message_search | ✅ pass | |
| F138 | Settings, Models & Providers | Open the Models settings page from the chat shell | 🟢 impl | models-settings.spec.ts (gear navigates to /settings/mod | ✅ pass | |
| F139 | Settings, Models & Providers | View current preferred model and reasoning effort | 🟢 impl | models.page.test.tsx ("reflects provider connection + gl | ✅ pass | |
| F140 | Settings, Models & Providers | See the per-provider default model as Preferred before any explicit pick | 🟢 impl | models-settings.spec.ts (asserts GPT-5.5 row shows Prefe | ✅ pass | |
| F141 | Settings, Models & Providers | Set a preferred model from the catalog table | 🟢 impl | models-settings.spec.ts (hover GPT-5.4 Mini row, click " | ✅ pass | |
| F142 | Settings, Models & Providers | Change the global reasoning effort | 🟢 impl | models-settings.spec.ts (click High radio, assert aria-c | ✅ pass | |
| F143 | Settings, Models & Providers | Have model and effort choices persist across reload and into Runs | 🟢 impl | models-settings.spec.ts (full page reload, both Mini-as- | ✅ pass | |
| F144 | Settings, Models & Providers | Reject unknown model ids and invalid effort values | 🟢 impl | protocol.rs decode tests for SettingsSetParams (only_eff | ✅ pass | |
| F145 | Settings, Models & Providers | Browse the model catalog with cost and capability chips | 🟢 impl | models-settings.spec.ts (runs against real openai-codex | ✅ pass | |
| F146 | Settings, Models & Providers | Pick the model from the composer model picker | 🟢 impl | no dedicated spec found; covered indirectly by settings/ | ✅ pass | |
| F147 | Settings, Models & Providers | Adjust reasoning effort from the composer effort picker | 🟢 impl | no dedicated spec found; EffortControl.test.tsx covers t | ✅ pass | |
| F148 | Settings, Models & Providers | View the ChatGPT provider connection status | 🟢 impl | connect-provider.spec.ts (asserts provider-status reads | ✅ pass | |
| F149 | Settings, Models & Providers | Connect ChatGPT via OAuth | 🟢 impl | connect-provider.spec.ts (Connect with stubbed login hel | ✅ pass | |
| F150 | Settings, Models & Providers | See the connection flip to Connected after returning to the tab | 🟢 impl | connect-provider.spec.ts (dispatches focus events in a p | ✅ pass | |
| F151 | Settings, Models & Providers | Have provider credentials refreshed and injected into Runs securely | 🟢 impl | credentials.rs unit tests (write_then_read_round_trips_a | ✅ pass | |
| F152 | Settings, Models & Providers | exit-settings-takeover-esc-and-back | ⚪ gap | none | ▢ verify | |
| F153 | Settings, Models & Providers | login-opens-authorize-url-in-new-tab | ⚪ gap | none | ▢ verify | |
| F154 | Run Control & Lifecycle | Cancel a running run | 🟢 impl | tests/e2e/src/run-cancel.spec.ts (raw WebSocket: thread/ | ✅ pass | |
| F155 | Run Control & Lifecycle | Cancel a run parked on a proposal | 🟢 impl | tests/e2e/src/run-cancel-parked.spec.ts (UI Stop on a pa | ✅ pass | |
| F156 | Run Control & Lifecycle | Cancelling an already-finished run is a no-op result | 🟢 impl | unit tests cancel.rs running_lost_to_committed_terminal_ | ✅ pass | |
| F157 | Run Control & Lifecycle | Cancelling an unknown run id returns unknown_run | 🟢 impl | unit test cancel.rs unknown_run_is_unknown_run; handler. | ✅ pass | |
| F158 | Run Control & Lifecycle | Stop button in the composer cancels the active run | 🟢 impl | tests/e2e/src/run-cancel-ui.spec.ts (gated 2-chunk fixtu | ✅ pass | |
| F159 | Run Control & Lifecycle | Cancelled run shows a neutral stopped bubble, not an error | 🟢 impl | tests/e2e/src/run-cancel-ui.spec.ts and run-cancel-parke | ✅ pass | |
| F160 | Run Control & Lifecycle | A failed run surfaces an error in the assistant bubble | 🟢 impl | tests/e2e/src/run-error.spec.ts (faux fauxError -> assis | ✅ pass | |
| F161 | Run Control & Lifecycle | Each terminal run records a typed terminal reason | 🟢 impl | unit test lifecycle.rs terminal_reason_as_str_matches_ch | ✅ pass | |
| F162 | Run Control & Lifecycle | Run status changes only through guarded transition verbs with cancel-wins semantics | 🟢 impl | unit tests across cancel.rs (won/lost races) and lifecyc | ✅ pass | |
| F163 | Run Control & Lifecycle | Reconnect to a live run via snapshot-then-tail | 🟢 impl | tests/e2e/src/background-stream.spec.ts (a backgrounded | ✅ pass | |
| F164 | Run Control & Lifecycle | Reconnect to an already-ended or parked run emits the right closing event | 🟢 impl | tests/e2e/src/reconnect-parked.spec.ts (reload drops soc | ✅ pass | |
| F165 | Run Control & Lifecycle | Cancelling a running run promptly stops the live worker | 🟢 impl | tests/e2e/src/run-cancel-ui.spec.ts (the gated tail neve | ✅ pass | |
| F166 | Run Control & Lifecycle | Run lifecycle milestones are recorded durably | 🟢 impl | tests/e2e/src/run-lifecycle-record.spec.ts (park->decide | ✅ pass | |
| F167 | Run Control & Lifecycle | ws-connection-drop-and-reconnect | ⚪ gap | none | ▢ verify | |
| F168 | Run History & Activity | See a recency-grouped feed of recent runs in the right rail | 🟢 impl | RunFeed.test.tsx 'renders live history grouped by recenc | ✅ pass | |
| F169 | Run History & Activity | Runs are ordered newest-first by latest milestone time | 🟢 impl | run-history-feed.spec.ts wire angle; db/mod.rs list_run_ | ✅ pass | |
| F170 | Run History & Activity | Each run shows its latest lifecycle milestone, returned verbatim | 🟢 impl | db/mod.rs list_run_history_orders_by_recency_with_verbat | ✅ pass | |
| F171 | Run History & Activity | Milestone kinds map to human labels, icons, and tone in the client | 🟢 impl | RunFeed.test.tsx asserts Done/Running, resumed/Failed/Wa | ✅ pass | |
| F172 | Run History & Activity | Each run row is labeled by its owning thread's title | 🟢 impl | run-history-feed.spec.ts asserts titles; RunFeed.test.ts | ✅ pass | |
| F173 | Run History & Activity | Each run row shows a relative time/date stamp | 🟢 impl | RunFeed.test.tsx pins Date.now() and asserts '/Done ·/' | ✅ pass | |
| F174 | Run History & Activity | Click a run row to open its thread | 🟢 impl | RunFeed.test.tsx 'opens a run's thread when its row is c | ✅ pass | |
| F175 | Run History & Activity | Feed shows distinct loading, empty, and error states | 🟢 impl | RunFeed.test.tsx 'shows a teaching empty state', 'shows | ✅ pass | |
| F176 | Run History & Activity | Run history is bounded by a default and hard-capped limit | 🟢 impl | db/mod.rs list_run_history capped read assertion; ui-sdk | ✅ pass | |
| F177 | Run History & Activity | Feed refreshes after sending a message or retrying a run | 🟢 impl | run-history-feed.spec.ts parked-run DOM test (reload re- | ✅ pass | |
| F178 | Run History & Activity | See a live tool-call activity row inside an assistant turn | 🟢 impl | tool-activity.spec.ts 'a read_thread call renders a comp | ✅ pass | |
| F179 | Run History & Activity | Tool rows show humanized labels, glyphs, and read-only chips per tool | 🟢 impl | tool-activity.spec.ts asserts 'Read this thread' + 'read | ✅ pass | |
| F180 | Run History & Activity | Repeated tool calls collapse into one grouped row; errored calls break out | 🟢 impl | ToolActivity.test.tsx 'groupToolCalls' suite and 'ToolAc | ✅ pass | |
| F181 | Run History & Activity | Running tool rows settle when the run ends | 🟢 impl | none | ▢ verify | |
| F182 | Run History & Activity | Tool-call activity survives a page reload | 🟢 impl | tool-activity-reload.spec.ts 'a tool-activity row surviv | ✅ pass | |
| F183 | Run History & Activity | Activity Rail (edits + automations) — visual-only mock, not wired | 🔵 stub/mock | ActivityRail.test.tsx 'groups rows into Today/Yesterday/ | ✅ pass | |
| F184 | Run History & Activity | Automations and automation-run hooks are mock-backed placeholders | 🔵 stub/mock | ActivityRail.test.tsx exercises these hooks indirectly v | ✅ pass | |
| F185 | Agent / Worker / Skills | Agent reads another thread's messages by id | 🟢 impl | tests/e2e/src/tool-read-thread.spec.ts (cross-thread rea | ✅ pass | |
| F186 | Agent / Worker / Skills | Agent reads accepted journal entries created from the current thread | 🟢 impl | crates/core/tests/current_thread_journal_entries.rs (Cor | ✅ pass | |
| F187 | Agent / Worker / Skills | Agent searches accepted People, Projects, and Todos | 🟢 impl | Unit tests in search_entities.rs (name/alias match, todo | ✅ pass | |
| F188 | Agent / Worker / Skills | Agent loads a skill procedure by name mid-run | 🟢 impl | tests/e2e/src/skill-activation.spec.ts (browser-level: a | ✅ pass | |
| F189 | Agent / Worker / Skills | Available skills are advertised in every run's system prompt | 🟢 impl | Unit tests in skills.rs (scan eligibility/sorting, rende | ✅ pass | |
| F190 | Agent / Worker / Skills | Untrusted skill metadata cannot break out of the advertised-skills block | 🟢 impl | Unit tests in skills.rs: scan_neutralizes_unsafe_descrip | ✅ pass | |
| F191 | Agent / Worker / Skills | Bundled example skills are seeded on first run and respect user edits | 🟢 impl | Unit tests in skills.rs: seed_if_absent_populates_then_r | ✅ pass | |
| F192 | Agent / Worker / Skills | The Dispatcher picks a workflow once per fresh run | 🟢 impl | crates/core/tests/run_records_workflow.rs (run row recor | ✅ pass | |
| F193 | Agent / Worker / Skills | The run's model and effort are resolved from the user's settings | 🟢 impl | crates/core/tests/run_uses_selected_model.rs; crates/cor | ✅ pass | |
| F194 | Agent / Worker / Skills | The default workflow defines the agent's system prompt and tool allowlist | 🟢 impl | crates/core/tests/workflow_load.rs (load/validate/fail-f | ✅ pass | |
| F195 | Agent / Worker / Skills | load_skill is always available regardless of the workflow allowlist | 🟢 impl | tools/mod.rs unit tests: run_descriptors_appends_ambient | ✅ pass | |
| F196 | Agent / Worker / Skills | Agent recognizes a journal-worthy message with entities as one intent graph | 🟢 impl | tests/e2e/src/intent-graph-review.spec.ts (accept-all, e | ✅ pass | |
| F197 | Agent / Worker / Skills | Accepting an intent graph resolves reuse-vs-create and applies all nodes atomically | 🟢 impl | Extensive unit tests in intent_graph.rs (plan dispositio | ✅ pass | |
| F198 | Agent / Worker / Skills | Agent's intent-graph proposal shows create/reuse/ambiguous/near-match badges before I decide | 🟢 impl | Unit tests in intent_graph.rs: resolved_plan_omits_je_an | ✅ pass | |
| F199 | Agent / Worker / Skills | Agent proposes a journal entry for journal-worthy material in the same thread | 🟢 impl | crates/core/tests/proposal_journal_entry_source.rs; prop | ✅ pass | |
| F200 | Agent / Worker / Skills | Agent directly captures reminders, projects, and people without a journal entry | 🟢 impl | tests/e2e/src/direct-capture.spec.ts (Todo/Project/Perso | ✅ pass | |
| F201 | Agent / Worker / Skills | Each tool call surfaces a human-readable activity row | 🟢 impl | tests/e2e/src/skill-activation.spec.ts (asserts 'Loaded | ✅ pass | |
| F202 | UI Shell & Theming (critic-found) | toggle-light-dark-theme | ⚪ gap | none | ▢ verify | |
| F203 | UI Shell & Theming (critic-found) | collapse-expand-right-rail | ⚪ gap | none | ▢ verify | |

---

## Detailed acceptance criteria

### Chat & Messaging

#### F001 · Compose and send a message into the focused thread — 🟢 impl

*As the owner, I want to type a message in the compose footer and send it into the conversation I'm viewing, so that I can ask the assistant something within an existing thread.*

**Expected behavior.** ComposeFooter.tsx submit() trims the textarea value (ComposeFooter.tsx:31), no-ops on empty/whitespace-only input (`if (!trimmed) return`, :32), then calls onSend(trimmed) and clears the box (:33-34). Enter sends, Shift+Enter inserts a newline (handleKey, :42-47); the form's onSubmit also routes to submit(). ChatColumn.onSend (ChatColumn.tsx:253) routes to send(runtime, focusedThreadId, text) when a thread is focused. bridge.send (bridge.ts:109) marks the thread hydrated (so focus-hydrate won't re-fetch), optimistically seeds the turn (a completed `user` message with a single text segment + a streaming `assistant` message with empty segments, seedTurn :44-64), calls client.postMessage(threadId, text) (:120), attaches the returned run_id to the seeded assistant message, and forks the run stream. Core post_message.rs handle() requires a `thread_id` (PostMessageParams, protocol.rs:28); it returns ONLY `{run_id}` (PostMessageResult, post_message.rs:90-92) — the client follows with run/subscribe. Edge: a well-formed but unknown thread_id is rejected with UnknownThread BEFORE any rows are written (post_message.rs:34-39). Edge: an empty composer submit is suppressed client-side; while a run is active the submit early-returns (`if (isRunning) return`, ComposeFooter.tsx:30) so Enter can't fire a second turn. On postMessage failure the seeded assistant message is marked incomplete and a 'Couldn't send your message. Please try again.' alert is shown (bridge.ts:130, ChatColumn.tsx:260-261).

**Key files:** `apps/web/src/components/ComposeFooter.tsx:27-54`, `apps/web/src/components/ChatColumn.tsx:253-280`, `apps/web/src/store/bridge.ts:44-133`, `crates/core/src/runs/post_message.rs:22-95`, `crates/core/src/protocol.rs:27-31`

**Existing coverage:** tests/e2e/src/interpreter-chat.spec.ts (sends, asserts streamed completion); tests/e2e/src/chat-surface.spec.ts (send replaces welcome); apps/web/src/components/ComposeFooter.test.tsx

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F002 · First message on the welcome screen mints a new thread — 🟢 impl

*As the owner, I want to type my first message with no thread open and have a new conversation created automatically, so that I can start chatting without first creating a thread.*

**Expected behavior.** When focusedThreadId is null (welcome route), ChatColumn.onSend calls sendNewThread(runtime, text) (ChatColumn.tsx:268). bridge.sendNewThread (bridge.ts:142) calls client.threadCreate(text), then on success marks the new thread `ready`, seeds the turn, attaches the run, starts the stream, and returns `{ok:true, threadId}`; ChatColumn then navigates to `/thread/$threadId` (ChatColumn.tsx:270-273). Core ThreadCreateParams carries just `prompt` (protocol.rs:256-259); an empty/whitespace prompt is rejected with invalid_params via the trim-empty guard in handle_thread_create (per protocol.rs:254-255 doc). The thread is pre-seeded and marked ready so the post-navigate remount reads it without a re-hydrate (bridge.ts:153-154). Edge: on threadCreate failure nothing is seeded (no orphaned bubble) and the error alert is shown while staying on `/` (bridge.ts:159-162, ChatColumn.tsx:274-275).

**Key files:** `apps/web/src/components/ChatColumn.tsx:263-277`, `apps/web/src/store/bridge.ts:142-163`, `crates/core/src/protocol.rs:253-268`

**Existing coverage:** tests/e2e/src/chat-surface.spec.ts ('replaces the welcome with the transcript after the first send'); tests/e2e/src/thread-routing.spec.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F003 · Watch the assistant's reply stream in token-by-token — 🟢 impl

*As the owner, I want to see the assistant's reply appear progressively as it is generated, so that I get immediate feedback instead of waiting for the whole answer.*

**Expected behavior.** After send, startRunStream (bridge.ts:67) forks client.subscribeRun(runId) and drives each event into applyEvent until a done/error/cancelled terminal (Stream.takeUntil, :84-90). Core run/subscribe replies snapshot-then-tail (subscribe.rs:5-8): the cumulative text rides as ONE text_delta, then live deltas tail. applyEvent's text_delta branch (chat.ts:638-657) honors the ADR-0022 SET-vs-APPEND boundary via the run record's snapshotArmed bit: the FIRST delta after subscribe SETs the cumulative snapshot, subsequent deltas APPEND; the bit is then disarmed (:648-656). The text is threaded into the ordered segments[] timeline (appendTextSegment, chat.ts:444-460): an armed snapshot collapses ALL text segments into one (setCumulativeText, :471-490) so concatText(segments) always equals the flat snapshot; a disarmed append extends the open trailing text segment or opens a fresh one if a tool/proposal just sealed the run. The bubble renders the text segment(s) through ChatMarkdown (ChatColumn.tsx:464). Edge: a broadcast buffer overflow re-snapshots (subscribe.rs:158-159, Lagged arm) so a lagging subscriber recovers the full cumulative text. Edge: the duplicated-prefix bug (concatText='A'+'A B') is specifically prevented by collapsing every text segment on a snapshot SET (chat.ts:436-443 doc).

**Key files:** `apps/web/src/store/bridge.ts:67-106`, `apps/web/src/store/chat.ts:627-704`, `apps/web/src/store/chat.ts:444-490`, `crates/core/src/runs/subscribe.rs:34-67`, `crates/core/src/protocol.rs:535-554`

**Existing coverage:** tests/e2e/src/chat-markdown.spec.ts ('streaming render' describe — gated mid-stream shows partial then full); tests/e2e/src/interpreter-chat.spec.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F004 · See an assistant turn's pieces (text, tool activity, proposal) in chronological order — 🟢 impl

*As the owner, I want the tool-activity rows, decided proposal card, and reply text within one assistant turn to appear in the order they actually happened, so that the conversation reads as a coherent timeline (e.g. the 'Applied.' pill above the reply it preceded).*

**Expected behavior.** The wire MessageView carries an ordered `segments[]` (protocol.rs:499-506) — a `#[serde(tag="kind")]` union of Text / ToolCall{name,status,arg?} / Proposal{proposal_id,mutation_kind,status,entity_id?} (Segment, protocol.rs:459-490) — replacing the old three independent buckets, sequenced by run_steps (ADR-0045). AssistantBubble (ChatColumn.tsx:418) maps segments through toRenderGroups (:399-416), which coalesces consecutive tool_call segments into one ToolActivity group while keeping text/proposal segments between them in arrival order, then renders each group in order: tools→ToolActivity, proposal→AssistantProposals, text→ChatMarkdown (:444-467). Live and reloaded renders are byte-for-byte the same component path: live builders (appendTextSegment, upsertToolSegment, appendProposalSegment in chat.ts) build the same shape the wire carries; hydration maps wire segments verbatim (hydrate.ts toSegment :39-61, toMessage :67-85). Edge: a tool_call segment carries no durable id, so hydration synthesizes a stable `<messageId>:seg:<i>` React key (hydrate.ts:51); a rehydrated tool call is never `running` (toToolCallStatus settles to completed/error, :28-30). Edge: proposal tool calls are NOT emitted as ToolCall segments — they become a Proposal segment (protocol.rs:466-468).

**Key files:** `crates/core/src/protocol.rs:449-506`, `apps/web/src/components/ChatColumn.tsx:388-467`, `apps/web/src/store/chat.ts:22-25`, `apps/web/src/store/hydrate.ts:39-85`, `docs/adr/0045-assistant-turn-segment-timeline.md`

**Existing coverage:** tests/e2e/src/segment-timeline-reload.spec.ts (pill-above-reply order, live + reload); tests/e2e/src/tool-activity-reload.spec.ts; tests/e2e/src/proposal-decided-reload.spec.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F005 · Read assistant replies as formatted markdown — 🟢 impl

*As the owner, I want the assistant's reply rendered with headings, lists, tables, code blocks, and links rather than raw markdown text, so that structured answers are legible.*

**Expected behavior.** ChatMarkdown.tsx renders the text segment through ReactMarkdown with the remark-gfm plugin (ChatMarkdown.tsx:1-16), so GFM constructs (tables, etc.) render as real HTML. Links are overridden to open in a new tab safely: every `<a>` gets target="_blank" rel="noreferrer noopener" (ChatMarkdown.tsx:9-11). AssistantBubble wraps each text group in a `prose prose-pink dark:prose-invert` container (ChatColumn.tsx:462). Markdown renders the same whether streaming or completed (the text group always routes through ChatMarkdown). Edge: links carry both noreferrer and noopener so opened tabs can't reach window.opener.

**Key files:** `apps/web/src/components/ChatMarkdown.tsx:1-17`, `apps/web/src/components/ChatColumn.tsx:457-466`

**Existing coverage:** tests/e2e/src/chat-markdown.spec.ts ('assistant markdown reply renders as formatted HTML' — real h1, GFM table, a[target=_blank] rel~=noreferrer); tests/e2e/src/chat-markdown-gallery.spec.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F006 · See a typing indicator before the assistant's first text arrives — 🟢 impl

*As the owner, I want an animated typing indicator while the assistant is working but has produced no text yet, so that I know the assistant is responding before any words appear.*

**Expected behavior.** AssistantBubble shows a three-dot pulsing typing indicator only when message.status === 'streaming' AND the derived flat text (concatText(segments)) is empty AND no tool call is currently running (ChatColumn.tsx:468-479). It carries role='status', aria-label='Assistant is typing', data-testid='typing-indicator'. Once any text segment arrives (text !== '') or a tool starts running, the indicator disappears. Edge: when the first chunk already carries text (e.g. a 2-chunk echo whose chunk 1 is non-empty) the empty-text window never opens, so the indicator is not observable — asserted only by ABSENCE in e2e (chat-markdown.spec.ts:96-101 doc). The animation is gated on motion-safe for reduced-motion users (:475-477).

**Key files:** `apps/web/src/components/ChatColumn.tsx:429-432`, `apps/web/src/components/ChatColumn.tsx:468-479`

**Existing coverage:** tests/e2e/src/chat-markdown.spec.ts (asserts indicator ABSENT once text present); the empty-text-visible case noted as covered authoritatively by a vitest test (chat-markdown.spec.ts:96-101 doc)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F007 · Copy a completed assistant reply to the clipboard — 🟢 impl

*As the owner, I want a copy button on a finished assistant reply that copies its text, so that I can paste the answer elsewhere.*

**Expected behavior.** AssistantBubble renders a CopyButton only when message.status === 'completed' AND the derived flat text length > 0 (ChatColumn.tsx:480-484); it lives in a hover/focus-revealed container (opacity-0 → group-hover/focus-within opacity-100). The copied text is concatText(message.segments) — the single source of truth derived from the text segments (ChatColumn.tsx:429, ADR-0045: no denormalized flat text). CopyButton.tsx calls useCopyToClipboard().copy(text) (CopyButton.tsx:13-15), which does navigator.clipboard.writeText and flips `copied` true for 2000ms (useCopyToClipboard.ts:14-19), swapping the Copy glyph for a Check (CopyButton.tsx:18-23, aria-label 'Copy'). Edge: the reset timer is cleared on unmount and re-cleared on a repeat copy (useCopyToClipboard.ts:8-17). Edge: a streaming or incomplete reply shows NO copy button; only completed+non-empty does.

**Key files:** `apps/web/src/components/ChatColumn.tsx:480-484`, `apps/web/src/components/CopyButton.tsx:6-25`, `apps/web/src/lib/hooks/useCopyToClipboard.ts:4-22`

**Existing coverage:** tests/e2e/src/chat-markdown.spec.ts ('copy button' describe — clicking copy writes reply text to clipboard, asserted via clipboardText())

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F008 · Stop a running or parked assistant turn from the composer — 🟢 impl

*As the owner, I want the Send button to become a Stop button while a turn is active so I can cancel it, so that I can interrupt a long or unwanted response.*

**Expected behavior.** ComposeFooter swaps the Send icon button (ArrowUp, aria-label 'Send', type='submit') for a Stop icon button (Square, aria-label 'Stop', type='button') when isRunning is true (ComposeFooter.tsx:99-118). ChatColumn passes isRunning = activeRunId !== null (ChatColumn.tsx:249); activeRunId is set while a Run streams AND while it's parked awaiting a Proposal (only a terminal Run Event clears it, ChatColumn.tsx:46-48). onStop calls cancelRun(runtime, activeRunId) (:250-252). bridge.cancelRun (bridge.ts:206) fires run/cancel and settles the UI off the authoritative outcome: it interrupts the subscribe fiber, applies a synthetic `cancelled` event, and clears any pending proposal (:248-250) — EXCEPT `already_terminal` on a non-parked run, where the live stream owns the real terminal (:242-244). Edge: `unknown_run` still settles (Core has no hub, so no event will come — bailing would wedge Stop, bridge.ts:202-203 doc). Edge: a parked run always settles since it has no live tail. Edge: a failed run/cancel request leaves the run as-is (best-effort, bridge.ts:218-221). While running, Enter/submit can't start a second turn (ComposeFooter.tsx:30).

**Key files:** `apps/web/src/components/ComposeFooter.tsx:99-118`, `apps/web/src/components/ChatColumn.tsx:248-252`, `apps/web/src/store/bridge.ts:192-251`, `crates/core/src/protocol.rs:51-62`

**Existing coverage:** tests/e2e/src/run-cancel-ui.spec.ts; tests/e2e/src/page-objects/ChatPage.ts (stop() helper)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F009 · See model/effort pickers and disabled Search/Attach in the composer — 🟡 partial

*As the owner, I want the composer to offer model and effort selection and show that web search and attachments are coming, so that I can tune the response and understand which capabilities exist.*

**Expected behavior.** ComposeFooter renders a ModelPicker and EffortPicker (ComposeFooter.tsx:76-77) plus two DISABLED chip buttons: Search (aria-label 'Search (coming soon)', title 'Web search isn\'t available yet', :78-87) and Attach (aria-label 'Attach (coming soon)', title 'Attachments aren\'t available yet', :88-97). The composer chrome is click-to-focus: clicking the form (but not a nested control) focuses the textarea (focusTextarea, :49-54). The textarea is a single auto-resizing row with placeholder 'Type your message here…' and aria-label 'Message' (:64-72). Edge: Search and Attach are non-functional stubs surfaced only to communicate roadmap; clicking them does nothing.

**Key files:** `apps/web/src/components/ComposeFooter.tsx:56-122`

**Existing coverage:** apps/web/src/components/ComposeFooter.test.tsx

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F010 · Land on a first-run welcome that teaches the chat→Library loop — 🟢 impl

*As the owner, I want a helpful welcome screen when no thread is open and there are no messages, so that I understand what Inkstone does and how to begin.*

**Expected behavior.** ChatColumn computes showWelcome = focusedThreadId === null && messages.length === 0 (ChatColumn.tsx:64-65) and renders ChatWelcome (:207-208), an EmptyState (Sparkles icon, brand tone, lg size) titled 'Start a chat' explaining Inkstone drafts journal entries and structured items that land in the Library once approved (ChatWelcome :287-298). It animates in via motion-safe:animate-rise. The welcome is replaced by the transcript after the first send (the optimistic seed makes messages non-empty). Edge: a focused-but-empty thread does NOT show the welcome (showWelcome requires focusedThreadId === null) — it shows the hydration skeleton/error/not-found instead.

**Key files:** `apps/web/src/components/ChatColumn.tsx:64-65`, `apps/web/src/components/ChatColumn.tsx:286-299`, `docs/adr/0010-mvp-slice-chat-driven-web-client.md`

**Existing coverage:** tests/e2e/src/chat-surface.spec.ts ('opens with the first-run welcome', 'replaces the welcome with the transcript after the first send')

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F011 · See loading, recoverable-error, and not-found states when opening a thread — 🟢 impl

*As the owner, I want clear feedback (skeleton, retry, or dead-end) when I open a conversation that has to be fetched, so that I never stare at an eternal spinner or a broken page.*

**Expected behavior.** useHydrateFocusedThread fetches thread/get on focus change for a non-null thread never hydrated (hydrate.ts:220-232). hydrateThread sets `loading` before the fetch then `ready`/`error`/`not_found` on settle (hydrate.ts:148-217). ChatColumn renders: a placeholder-bubble skeleton (role='status', aria-label='Loading conversation') while hydration is null/loading and there are no messages (ChatHydrating, ChatColumn.tsx:74-77, 346-363); a recoverable error card (role='alert', 'Couldn\'t load this conversation', Try again button → retryHydration) on transient fetch failure (hydrationFailed branch :66-67, ChatHydrationError :302-322); a not-found dead-end ('This thread isn\'t available', Back to New Chat → navigate('/')) when Core reports the thread missing (threadNotFound :72-73, ChatThreadNotFound :329-345). Edge: both a genuinely missing thread (UnknownThreadError, -32001) AND a malformed thread id (InvalidParamsError, -32602, e.g. a typo'd shared /thread/<bad> link) map to not_found, never the retryable error path (hydrate.ts:191-196). Edge: if a send turns a 'missing' thread live mid-fetch, the live turn is kept (status forced ready) rather than blanked to not_found (hydrate.ts:200-205).

**Key files:** `apps/web/src/components/ChatColumn.tsx:61-77`, `apps/web/src/components/ChatColumn.tsx:301-363`, `apps/web/src/store/hydrate.ts:148-232`, `apps/web/src/store/chat.ts:83-90`

**Existing coverage:** No dedicated chat-* e2e found; covered indirectly by tests/e2e/src/thread-routing.spec.ts and the store hydration unit tests (apps/web/src/store/chat.test.tsx)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F012 · Reload mid-stream and resume the partial reply to completion — 🟢 impl

*As the owner, I want to refresh the page while a reply is streaming and have it pick up where it left off and finish, so that a refresh never loses an in-progress answer.*

**Expected behavior.** The Run is owned by Core, not the socket, so a refresh doesn't kill it. On reload the store reinitializes empty; hydrateThread fetches thread/get, which returns a `streaming` assistant MessageView with partial text and its run_id (protocol.rs:508-516 doc). toMessage narrows status to 'streaming' (hydrate.ts:69-74); loadThreadMessages points activeRunId at the streaming message's run (chat.ts:370-382). For each streaming message with a non-empty run_id, hydrateThread re-forks startRunStream (hydrate.ts:175-179), which calls beginRunSubscription to re-arm the snapshot bit so the resubscribe's first text_delta SETs the cumulative snapshot rather than appending (chat.ts:200-208). Core run/subscribe replies with status `running` (live hub still exists) and the cumulative snapshot, then tails (subscribe.rs:34-67). Edge: reload forgets focus; the user re-opens the thread from the sidebar (reload-mid-stream.spec.ts:22). Edge: a gated tail not yet arrived stays absent until the gate trips, then completes to the full text with exactly one assistant + one user bubble (reload-mid-stream.spec.ts:28-31).

**Key files:** `apps/web/src/store/hydrate.ts:148-179`, `apps/web/src/store/chat.ts:200-208`, `apps/web/src/store/chat.ts:370-382`, `crates/core/src/runs/subscribe.rs:34-67`

**Existing coverage:** tests/e2e/src/reload-mid-stream.spec.ts ('reload mid-stream rehydrates the partial and resumes to completion')

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F013 · Keep a reply streaming while I navigate to another thread — 🟢 impl

*As the owner, I want a reply to keep streaming in the background when I switch away to another conversation or New Chat, so that switching contexts doesn't abort an in-progress answer.*

**Expected behavior.** Each run's stream fiber is retained keyed by run id in the bridge's `fibers` map (bridge.ts:24) and is NOT interrupted on focus change — only on explicit unmount/cancel (interruptRun, :171-178). startRunStream's finalizer deletes only its own map entry, identity-aware (bridge.ts:95-101). So navigating away (New Chat clears focus, the messages leave the viewport) leaves the background Run advancing; reopening the thread shows the full accumulated text. Edge: the off-screen run's deltas are still applied to the store (applyEvent targets the thread by id regardless of focus), so reopening reflects everything that streamed while off-screen.

**Key files:** `apps/web/src/store/bridge.ts:23-106`, `apps/web/src/store/bridge.ts:171-178`

**Existing coverage:** tests/e2e/src/background-stream.spec.ts ('a background Run keeps streaming while another thread is focused')

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F014 · Retry a stopped or failed assistant reply — 🟢 impl

*As the owner, I want a clear notice and a Try again button when a reply stops before finishing or errors out, so that I can re-run the turn without retyping.*

**Expected behavior.** When a Run terminates with an error event, applyEvent marks the assistant message status 'incomplete', attaches the worker/provider error message, and settles running tool segments to 'error' (chat.ts:675-684). A cancel produces 'incomplete' with NO error attached (chat.ts:686-694). AssistantBubble renders an alert (role='alert', data-testid='assistant-error') showing message.error or the fallback 'This reply stopped before it finished. Nothing was saved without your approval.' (ChatColumn.tsx:485-495). If the preceding message is a user turn, a 'Try again' button is shown (ChatColumn.tsx:496-505) wired to onRetry, which re-issues the previous user text via the `send` path (retry, :190-202) — always `send` since the thread already exists — and invalidates the threads + run-history queries. Edge: the retry text is concatText(messages[i-1].segments), reconstructed from the prior user turn's segments (ChatColumn.tsx:231). Edge: no Try again button is shown if there is no preceding user message (onRetry undefined, :229-233).

**Key files:** `apps/web/src/components/ChatColumn.tsx:189-202`, `apps/web/src/components/ChatColumn.tsx:485-507`, `apps/web/src/store/chat.ts:675-704`

**Existing coverage:** tests/e2e/src/run-cancel-ui.spec.ts (asserts the assistant-error settled state); apps/web/src/store/chat.test.tsx (applyEvent error/cancelled branches)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F015 · Land at the latest message on load and jump to a searched message — 🟢 impl

*As the owner, I want a freshly loaded thread to scroll to the bottom, and a ⌘K search hit to jump to and briefly highlight the matched message, so that I see the newest content immediately and can locate a specific message.*

**Expected behavior.** On cold-load/thread-switch the layout effect pins the scroller to the bottom once the thread's messages first render, keyed per-thread so streamed deltas don't re-pin, UNLESS a ?focusedMessageId anchor is pending (ChatColumn.tsx:110-117). A ⌘K message hit navigates with ?focusedMessageId; once that message is in the rendered DOM the effect scrolls it into center view (behavior:'auto', motion-reduce-safe), sets a transient lamplight highlight that fades after 1600ms, and consume-then-strips the URL param so a re-render can't re-fire the jump (ChatColumn.tsx:127-181). The matched row gets data-highlighted (UserBubble :379, AssistantBubble :461) and a search-jump-target ring. Edge: a URL-supplied focusedMessageId is CSS.escape'd before entering the attribute selector (defense-in-depth, :144). Edge: if hydration has settled and the anchored id genuinely isn't present (stale/deleted/typo'd), the anchor is stripped so it can't wedge the cold-load scroll (:147-160). message/search itself returns newest-first hits with snippet + thread_title (message.rs:17-41, protocol.rs:422-439).

**Key files:** `apps/web/src/components/ChatColumn.tsx:92-181`, `apps/web/src/components/ChatColumn.tsx:365-386`, `crates/core/src/runs/message.rs:17-41`

**Existing coverage:** tests/e2e/src/scroll-to-message.spec.ts; tests/e2e/src/message-search.spec.ts; crates/core/src/runs/message.rs (search unit tests)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F016 · Assistant action buttons component (mock-only, not wired into the live chat) — 🔵 stub/mock

*As the owner, I want labeled action chips (read/search/write/decide) under an assistant message, so that I could see what the assistant did at a glance.*

**Expected behavior.** AssistantActions.tsx renders a row of ghost chip Buttons, one per action, each with a kind→icon map (read→Eye, search→Search, write→Edit3, decide→CheckCircle2) and the action's label, plus data-action=<kind> (AssistantActions.tsx:5-37). It returns null when actions is undefined (:19). However it is typed against MockChatMessage (`@/data/mock/types`, AssistantActions.tsx:2) and has NO live importer — a repo-wide grep finds it referenced only by its own file. The live assistant turn instead surfaces tool activity through the segment timeline (ToolActivity via toRenderGroups in ChatColumn.tsx). Likewise useConversation.ts is a mock-data hook (`@/data/mock/conversation`) with no live importer. Edge: these are scaffolding/mock components, not part of the shipped chat behavior — treat any 'action button' requirement as served by ToolActivity + AssistantProposals in the real timeline, not AssistantActions.

**Key files:** `apps/web/src/components/AssistantActions.tsx:1-38`, `apps/web/src/lib/hooks/useConversation.ts:1-11`

**Existing coverage:** none found (no live importer; not exercised by chat-* e2e)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F017 · composer-keyboard-send-and-newline — ⚪ gap

**Expected behavior.** CRITIC-FOUND GAP (no story written yet): ComposeFooter implements a keyboard send contract the user triggers constantly but no story names: Enter sends, Shift+Enter inserts a newline, an empty/whitespace-only message is silently dropped (trim guard), the field clears on send, and crucially Enter is suppressed while a Run is active so it cannot fire a second turn over a live/parked one (Stop is click-only). The existing chat-send/stop stories cover the outcome of sending and stopping but not these input/keyboard semantics or the running-suppression guard.

**Key files:** `/Users/lyuhongy/dev/inkstone/apps/web/src/components/ComposeFooter.tsx (submit, handleKey, focusTextarea), /Users/lyuhongy/dev/inkstone/apps/web/src/components/ComposeFooter.test.tsx`

**Existing coverage:** none found

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

### Threads

#### F018 · Create a new thread by sending a first message — 🟢 impl

*As the owner, I want to type a prompt on the welcome screen and have a new thread minted from it, so that I can start a fresh conversation without any explicit "new thread" step.*

**Expected behavior.** On `/` (welcome) with no focused thread, `ChatColumn.onSend` (ChatColumn.tsx:253-280) calls `sendNewThread(runtime, text)` (bridge.ts:142-163), which invokes the SDK `threadCreate(text)` → Core `thread/create` handler (thread_create.rs:27-95). Core trims the prompt; mints a Thread id, Run id, user-message id, and assistant-message id (all `Uuid::now_v7`, time-ordered); dispatches a Workflow via `dispatcher::dispatch_and_resolve`; persists thread + first Run + user message in one transaction via `db::persist_thread_with_first_run`; creates the run hub BEFORE spawning the worker; and returns `{thread_id, run_id}` (ThreadCreateResult, protocol.rs:264-268). The bridge pre-marks the new thread `hydration:"ready"` (so the post-navigate remount does NOT re-hydrate over the optimistic seed), optimistically seeds a completed user bubble + streaming assistant bubble (`seedTurn`), attaches the run, and forks the run stream. Edge/error: an empty or whitespace-only prompt is rejected with `invalid_params` (-32602) BEFORE any DB write — zero rows persisted (thread_create.rs:37-42); if `threadCreate` throws, `sendNewThread` returns `{ok:false}` with nothing seeded, ChatColumn stays on `/` and shows "Couldn't send your message. Please try again." (ChatColumn.tsx:274-276).

**Key files:** `apps/web/src/components/ChatColumn.tsx:253-280`, `apps/web/src/store/bridge.ts:142-163`, `apps/web/src/store/bridge.ts:44-64`, `crates/core/src/runs/thread_create.rs:27-95`, `crates/core/src/protocol.rs:253-268`

**Existing coverage:** tests/e2e/src/thread-routing.spec.ts:24-36 ("a first send mints a Thread and puts its id in the URL"); tests/e2e/src/chat-surface.spec.ts:20-36 (welcome replaced by transcript after first send)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F019 · Auto-derive a thread title from the first prompt — 🟢 impl

*As the owner, I want my new thread to be titled from the opening message, truncated sensibly, so that I can recognize the thread later in the sidebar without naming it myself.*

**Expected behavior.** In `thread_create.rs:44-46`, the title is the trimmed prompt truncated to `TITLE_MAX_CHARS = 80` Unicode scalars (`trimmed.chars().take(80).collect()`) — counted in scalars (not bytes) so the cut never splits a multi-byte character. The title is never empty because the empty-prompt guard (thread_create.rs:37-42) already rejected blanks. It is persisted via `db::insert_thread` (queries.rs:21-41) into the `threads.title` column and surfaced in `thread/list` (`ThreadSummary.title`) and `thread/get` (`ThreadGetResult.title`). Edge case noted in scroll-to-message.spec.ts:29-34: turn-1 prompt becomes the title via this 80-char truncation, which the test deliberately keeps free of the search needle so a title match can't masquerade as a body hit.

**Key files:** `crates/core/src/runs/thread_create.rs:23-46`, `crates/core/src/db/queries.rs:21-41`, `crates/core/src/protocol.rs:270-278`

**Existing coverage:** No direct title-truncation e2e; tests/e2e/src/scroll-to-message.spec.ts:29-34 documents the title-from-prompt behavior in a comment and relies on it indirectly

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F020 · See all my threads listed in the sidebar — 🟢 impl

*As the owner, I want my conversations to appear in the left sidebar, newest activity first, so that I can find and revisit past chats.*

**Expected behavior.** `Sidebar` (Sidebar.tsx) reads threads via `useThreads()` (useThreads.ts) — a TanStack Query under key `["threads"]` that calls the SDK `threadList()` → Core `thread/list` handler (thread_list.rs:12-34). Core reads every Thread via `db::list_threads`, whose SQL orders `last_activity_at DESC` (queries.rs:61-68), and maps each row to `ThreadSummary {id, title, last_activity_at}`. The sidebar renders each thread title as a button. The list is invalidated/refetched after each send and retry via `queryClient.invalidateQueries({queryKey:["threads"]})` (ChatColumn.tsx:199, 278). Edge cases: while loading or on error `data` is undefined → threads default to `[]` (Sidebar.tsx:25); an empty workspace shows the "No threads yet." empty state (Sidebar.tsx:65-68); `thread/list` is read-only so its only failure mode is an internal DB error (thread_list.rs:1-3).

**Key files:** `apps/web/src/components/Sidebar.tsx:23-124`, `apps/web/src/lib/hooks/useThreads.ts:7-20`, `crates/core/src/runs/thread_list.rs:12-34`, `crates/core/src/db/queries.rs:59-68`, `crates/core/src/protocol.rs:270-285`

**Existing coverage:** none found (no dedicated thread-list e2e; chat-surface.spec.ts touches the sidebar chrome only)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F021 · See threads grouped by recency in the sidebar — 🟢 impl

*As the owner, I want threads bucketed into Today / Yesterday / Earlier this week / Older, so that the sidebar stays scannable as threads accumulate.*

**Expected behavior.** `groupByRecency` (Sidebar.tsx:131-156) buckets threads by `last_activity_at` on local-calendar-day boundaries: `>= startOfToday` → "Today"; `>= startOfYesterday` → "Yesterday"; `>= startOfWeek` (start of today minus 6 days) → "Earlier this week"; else "Older". Threads arrive already newest-first from `thread/list`, so within each bucket order is preserved. Empty groups are dropped (`groups.filter(g => g.threads.length > 0)`). Each non-empty group renders a sticky section header (Sidebar.tsx:71-74). `now` defaults to `Date.now()`.

**Key files:** `apps/web/src/components/Sidebar.tsx:128-156`, `apps/web/src/components/Sidebar.tsx:64-122`

**Existing coverage:** none found

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F022 · Open a thread by clicking it in the sidebar — 🟢 impl

*As the owner, I want clicking a sidebar thread to navigate to that conversation, so that I can resume an earlier chat.*

**Expected behavior.** Each sidebar thread row is a button whose `onClick` calls `onOpenThread?.(item.id)` (Sidebar.tsx:92-104). The `_chat` layout wires `onOpenThread` to `navigate({to:"/thread/$threadId", params:{threadId}})` (_chat.tsx:23-25). Navigation (not a store mutation) is the focus mechanism per ADR-0042; this pushes a history entry. The currently-focused row is marked from the route: `Sidebar` reads `useParams({strict:false})` and compares `item.id === threadId` to set `isCurrent`, which renders a dot indicator, `bg-secondary/70` highlight, bold text, and `aria-current="true"` (Sidebar.tsx:20-21, 77-104). Opening the route triggers `useHydrateFocusedThread` in ChatColumn to fetch history if not already hydrated.

**Key files:** `apps/web/src/components/Sidebar.tsx:20-21,77-104`, `apps/web/src/routes/_chat.tsx:14-40`, `apps/web/src/routes/_chat/thread.$threadId.tsx:11-20`

**Existing coverage:** none found (sidebar click→open is exercised indirectly; thread-routing.spec.ts navigates via send/Back rather than sidebar click)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F023 · Copy a thread's id from the sidebar — 🟢 impl

*As the owner, I want a per-thread copy-id button, so that I can share or reference a specific thread.*

**Expected behavior.** Each sidebar row has a copy button (visible on hover/focus) with `aria-label={`Copy thread id for ${item.title}`}` and title "Copy thread id"; clicking it calls `navigator.clipboard?.writeText(item.id)` (Sidebar.tsx:105-115). The button uses the optional-chaining guard so a missing Clipboard API is a silent no-op. The id copied is the raw thread UUID, which matches the `/thread/<id>` URL form.

**Key files:** `apps/web/src/components/Sidebar.tsx:105-115`

**Existing coverage:** none found

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F024 · Start a new chat from the sidebar — 🟢 impl

*As the owner, I want a "New Chat" button that returns me to the blank welcome surface, so that I can begin a brand-new conversation.*

**Expected behavior.** The sidebar "New Chat" button (Sidebar.tsx:55-62) calls `onNewChat`, wired in `_chat.tsx:22` to `navigate({to:"/"})`. The `/` route renders `ChatColumn` (index.tsx:5-7) with no focused thread, so `showWelcome` is true (focusedThreadId === null && no messages) and the `ChatWelcome` empty state renders (ChatColumn.tsx:65, 207, 287-299). No thread is created until the first send (mint-on-send). Back/forward history is preserved: the New Chat → `/` transition is a normal history-writing navigation (thread-routing.spec.ts proves Back walks from a thread to the intervening `/`).

**Key files:** `apps/web/src/components/Sidebar.tsx:55-62`, `apps/web/src/routes/_chat.tsx:22`, `apps/web/src/routes/_chat/index.tsx:5-7`, `apps/web/src/components/ChatColumn.tsx:65,207,287-299`

**Existing coverage:** tests/e2e/src/thread-routing.spec.ts:90-100 ("New Chat returns to the root welcome route")

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F025 · Load a thread's full message history when opened — 🟢 impl

*As the owner, I want the conversation's prior messages to appear when I open a thread, so that I see the whole chat, not just live activity.*

**Expected behavior.** On focus change, `useHydrateFocusedThread` (hydrate.ts:220-232) fires `hydrateThread` for any focused id whose hydration status is `undefined` (never hydrated). `hydrateThread` (hydrate.ts:148-217) sets status `loading`, calls SDK `threadGet(threadId)` → Core `thread/get` (thread_get.rs:16-69). Core reads title + messages chronologically via `db::get_thread_with_messages`, mapping each message's ordered `segments[]` (text / tool_call / proposal) 1:1 to wire `Segment` variants (thread_get.rs:29-60), including a `streaming` assistant message carrying partial text + `run_id` for resubscribe. The web maps wire→live via `toMessage`/`toSegment` (hydrate.ts:39-85), calls `loadThreadMessages`, reconstructs decided Proposals (`rehydrateDecidedProposals`), resubscribes any `streaming` run via `startRunStream`, and sets status `ready`. While loading and empty, `ChatColumn` shows `ChatHydrating` skeleton bubbles (role=status, ChatColumn.tsx:74-77, 213, 346-363). Edge: a send during the fetch window (`threadBecameLive`) folds fetched history in front non-destructively via `prependHistory` instead of replacing (hydrate.ts:133-137, 158-165).

**Key files:** `apps/web/src/store/hydrate.ts:148-232`, `apps/web/src/store/hydrate.ts:39-85`, `crates/core/src/runs/thread_get.rs:16-69`, `apps/web/src/store/chat.ts:370-405`, `apps/web/src/components/ChatColumn.tsx:74-77,213,346-363`

**Existing coverage:** tests/e2e/src/thread-routing.spec.ts:38-55 (reload cold-hydrates the conversation)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F026 · Have each thread live at its own URL — 🟢 impl

*As the owner, I want the focused thread to be reflected in the address bar as /thread/<id>, so that I can bookmark and share links to specific conversations.*

**Expected behavior.** ADR-0042 makes the URL the single source of truth for thread focus. `/` is unconditionally the new-chat welcome (index.tsx); a focused thread is only ever `/thread/$threadId` (thread.$threadId.tsx:12-20). The pathless `_chat` layout (_chat.tsx) owns the shared `WorkspaceShell` (Sidebar + recent-runs rail) so the shell never remounts across the welcome↔thread crossing; only the center `<ChatColumn/>` swaps via `<Outlet/>`. `ChatColumn` and `Sidebar` read the focused id from the route via `useParams({strict:false})` (ChatColumn.tsx:43-44, Sidebar.tsx:20-21), not from any store field — `focusedThreadId`/`setFocusedThread` were deleted from the store. Thread navigation pushes history (back/forward walks the thread stack). After a successful mint-on-send, ChatColumn navigates to `/thread/$threadId` with the server-assigned id (ChatColumn.tsx:268-273).

**Key files:** `docs/adr/0042-url-addressable-threads.md:1-110`, `apps/web/src/routes/_chat.tsx:1-44`, `apps/web/src/routes/_chat/index.tsx:1-7`, `apps/web/src/routes/_chat/thread.$threadId.tsx:1-20`, `apps/web/src/components/ChatColumn.tsx:43-44,268-273`

**Existing coverage:** tests/e2e/src/thread-routing.spec.ts:24-36 (id in URL after first send); :102-129 (Back walks the thread history stack)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F027 · Survive a page reload on a thread — 🟢 impl

*As the owner, I want reloading the page while viewing a thread to restore that same conversation, so that a refresh doesn't dump me on the welcome screen.*

**Expected behavior.** Because focus is in the URL (ADR-0042) and the Zustand store reinitializes empty on reload (chat.ts:139-145), a reload onto `/thread/<id>` keeps the URL unchanged and cold-hydrates the conversation: `useHydrateFocusedThread` sees `undefined` status for the focused id and fires `thread/get`, rebuilding the full transcript (hydrate.ts:220-232). Cold-load scroll: `ChatColumn`'s `useLayoutEffect` (ChatColumn.tsx:110-117) pins the scroller to the bottom once `messages` first render for the focused thread (guarded by `initialScrollThread` ref so streamed deltas don't re-pin) — UNLESS a `?focusedMessageId` anchor is pending, which wins. Streaming survives the welcome→thread remount because run fibers live in a module-level `Map` in bridge.ts decoupled from React lifecycle (ADR-0042 Consequences).

**Key files:** `apps/web/src/store/hydrate.ts:220-232`, `apps/web/src/components/ChatColumn.tsx:110-117`, `apps/web/src/store/chat.ts:139-145`, `docs/adr/0042-url-addressable-threads.md:87-102`

**Existing coverage:** tests/e2e/src/thread-routing.spec.ts:38-55 (reload cold-hydrates same conversation); :57-88 (reloading a long thread cold-lands at the bottom/latest message)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F028 · Jump to a specific message via a deep link — 🟢 impl

*As the owner, I want opening /thread/<id>?focusedMessageId=<id> to scroll the exact message into view and highlight it, so that a search hit or shared link lands me on the right message.*

**Expected behavior.** The `/thread/$threadId` route validates an optional `focusedMessageId` search param (thread.$threadId.tsx:7-18). `ChatColumn` reads it via `useSearch({strict:false})` (ChatColumn.tsx:56-58). When the anchored message id is present in the rendered list, an effect (ChatColumn.tsx:127-171) escapes the id with `CSS.escape`, finds the `[data-message-id=...]` row, calls `scrollIntoView({block:"center", behavior:"auto"})` (motion-reduce-safe), sets `highlightId` to bloom the ~1.6s lamplight ring (ChatColumn.tsx:177-181, rendered as `data-highlighted` on the bubble), claims `initialScrollThread` so the bottom-scroll can't clobber the jump, and is one-shot via `scrolledAnchorId` ref so a later `messages` tick (e.g. a streaming delta) doesn't re-fire the jump. The anchor scroll has top priority over messages-arrived-bottom and live-streaming-stick-to-bottom (ADR-0042 scroll priority).

**Key files:** `apps/web/src/routes/_chat/thread.$threadId.tsx:4-20`, `apps/web/src/components/ChatColumn.tsx:56-59,92-101,119-181`, `apps/web/src/components/ChatColumn.tsx:365-386`

**Existing coverage:** tests/e2e/src/scroll-to-message.spec.ts:52-102 (⌘K hit deep-links to exact message, highlights, then strips)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F029 · Strip the message anchor from the URL after jumping — 🟢 impl

*As the owner, I want the ?focusedMessageId param removed once it has done its one-shot scroll, so that a reload or Back doesn't re-fire a stale highlight and the address bar stays clean.*

**Expected behavior.** After the anchor jump fires, `stripAnchor` (ChatColumn.tsx:131-137) calls `navigate({to:"/thread/$threadId", params:{threadId}, search:{}, replace:true})` — replacing (not pushing) so Back never lands on an un-stripped URL and no junk history entry is added (ADR-0042). The visual highlight remains ephemeral local state that fades after ~1600ms (ChatColumn.tsx:177-181). Edge case: a stale/absent anchor (id not in the thread) is also stripped once hydration has SETTLED (`hydration === "ready" || "not_found" || messages.length > 0`) so a dead anchor can't linger forever or wedge the cold-load bottom-scroll (ChatColumn.tsx:147-159).

**Key files:** `apps/web/src/components/ChatColumn.tsx:127-181`, `docs/adr/0042-url-addressable-threads.md:44-56`

**Existing coverage:** tests/e2e/src/scroll-to-message.spec.ts:99-102 (anchor stripped after consume); :104-126 (a stale ?focusedMessageId strips itself and still shows the thread)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F030 · See an honest not-found state for a missing or malformed thread URL — 🟢 impl

*As the owner, I want a clear "this thread isn't available" screen with a Back-to-New-Chat exit when a thread link can't be served, so that a stale, deleted, or typo'd link is a clear dead-end rather than an eternal spinner or a futile retry.*

**Expected behavior.** `hydrateThread` maps two deterministic dead-ends to status `not_found`: a genuinely missing Thread (Core `thread/get` returns `UnknownThread(thread_id)` → JSON-RPC -32001 mapped end-to-end → SDK `UnknownThreadError`, handler.rs:30-31,48,60) and a malformed id (Core `-32602` InvalidParams → SDK `InvalidParamsError`) — both caught via `Effect.catchTag` (hydrate.ts:181-197). When focused, empty, and `hydration === "not_found"`, `ChatColumn` renders `ChatThreadNotFound` (ChatColumn.tsx:72-73, 209-210, 326-345): an EmptyState titled "This thread isn't available" with a single "Back to New Chat" action that navigates to `/`. Critically there is NO retry affordance — a missing thread can't be re-fetched into being — which distinguishes it from the transient-error path. Note malformed ids reach Core because the route does not pre-validate the UUID; `ThreadGetParams.thread_id: uuid::Uuid` (protocol.rs:444-447) is what rejects non-UUIDs. Edge: a send that turned the "missing" thread live mid-fetch is kept as `ready` rather than blanked to not-found (hydrate.ts:198-207).

**Key files:** `apps/web/src/store/hydrate.ts:181-217`, `apps/web/src/components/ChatColumn.tsx:72-73,209-210,326-345`, `crates/core/src/runs/handler.rs:29-31,47-48,59-60`, `crates/core/src/runs/thread_get.rs:22-27`, `crates/core/src/protocol.rs:441-447`

**Existing coverage:** tests/e2e/src/thread-not-found.spec.ts:18-35 (unknown UUID shows not-found, no Try-again, Back-to-New-Chat → /); :37-50 (malformed id also shows not-found, no retry)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F031 · Recover from a transient failure loading a thread — 🟢 impl

*As the owner, I want a recoverable error with a Try-again button if loading a valid thread fails transiently, so that a one-off network/WS hiccup doesn't permanently break a real conversation.*

**Expected behavior.** When `thread/get` fails with a non-deterministic error (a transient `WsRequestError` that does NOT match the `UnknownThreadError`/`InvalidParamsError` catch tags), the program's promise rejects and `hydrateThread`'s rejection handler sets status `error` (unless a send made the thread live mid-fetch, in which case `ready`) (hydrate.ts:208-216). `ChatColumn` then shows `ChatHydrationError` (ChatColumn.tsx:66-67, 211, 301-323): a role=alert EmptyState "Couldn't load this conversation" with a "Try again" button calling `retryHydration` → `hydrateThread` again, which flips status back to `loading` then re-settles (ChatColumn.tsx:183-187). This path is deliberately kept separate from the not-found dead-end (ADR-0042 B-additive: retrying a -32001 is guaranteed to fail, so it routes to not-found instead).

**Key files:** `apps/web/src/store/hydrate.ts:198-217`, `apps/web/src/components/ChatColumn.tsx:66-67,183-187,211,301-323`

**Existing coverage:** none found (no e2e simulates a transient WsRequestError on a valid thread)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F032 · Open a thread from the recent-runs rail — 🟢 impl

*As the owner, I want clicking a run in the right-hand recent-runs rail to open its thread, so that I can jump back to a conversation from its recent activity.*

**Expected behavior.** The `_chat` layout renders a `RunFeed` in the right rail (`railLabel="recent runs"`) and wires its `onOpenThread` to `navigate({to:"/thread/$threadId", params:{threadId}})` (_chat.tsx:28-35). Per ADR-0042, the recent-runs rail — which previously focused a thread in place with no route change — is now a normal history-writing navigator like every other thread-opener (ADR-0042 Decision, lines 53-56). The run-history feed is refreshed alongside the thread list after each send/retry via `invalidateQueries({queryKey:["run-history"]})` (ChatColumn.tsx:200, 279).

**Key files:** `apps/web/src/routes/_chat.tsx:28-35`, `apps/web/src/components/ChatColumn.tsx:200,279`, `docs/adr/0042-url-addressable-threads.md:53-56`

**Existing coverage:** none found (RunFeed open-thread not covered by the four listed thread specs)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

### Proposals (lifecycle)

#### F033 · Agent submits a Workspace mutation as a Proposal — 🟢 impl

*As the owner (via the agent acting on their behalf), I want the agent to call propose_workspace_mutation with a mutation_kind + payload, so that a journal-worthy event/reflection is captured, or People/Projects/Todos are extracted from an accepted Journal Entry, for my review.*

**Expected behavior.** The Core-registered tool descriptor (propose_workspace_mutation.rs `descriptor()`, NAME="propose_workspace_mutation") advertises a top-level `oneOf` over exactly the 14 agent-proposable mutation kinds (ProposableMutation::ALL), each variant binding `mutation_kind` (enum of its wire string), `payload` (the kind's `payload_spec().json_schema()`), and a nullable `rationale`. The tool has NO `execute`: it is a Tool Request whose Tool Result is a user Decision. The 4 user-only kinds (bookmarks + mark_project_reviewed) are deliberately absent from this surface (validated elsewhere). Schema is fully inlined Draft-07 with NO `$ref` (Anthropic rejects refs — asserted by `descriptor_intent_graph_has_no_ref`). The description gates Journal Entry capture on journal-worthy material and forbids a bare reminder/task from becoming a Journal Entry, while advertising People/Projects/Todos extraction (`descriptor_supports_extraction_but_excludes_bare_reminders_from_journal_entries`). Per-kind required/property sets and divergences (bare vs UUID-patterned ids, minItems on JE body only) are pinned by `schema_fields_and_divergences_trace_to_the_spec`.

**Key files:** `crates/core/src/tools/propose_workspace_mutation.rs:22`, `crates/core/src/tools/propose_workspace_mutation.rs:10`, `crates/core/src/mutation.rs:1`

**Existing coverage:** proposal-review.spec.ts (renders a pending Journal Entry proposal); tests/contract/fixtures parity gate via regenerate_schema_fixtures/fixtures_match_committed; many crates/core/tests/proposal_*.rs

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F034 · A pending Proposal parks the Run and tears the Worker down — 🟢 impl

*As the owner, I want the Run to pause and the agent process to stop while my Proposal awaits my decision, so that a Proposal can wait minutes-to-weeks without holding an idle Worker, and survive a Core restart.*

**Expected behavior.** In worker/run.rs the stdout read loop, on the FIRST `tool_request` where `tools::is_proposal(name) && !db::should_auto_approve()`, calls `park_on_proposal` then shuts the worker down and `break`s — so only that one Proposal is persisted and parked; sibling tool calls the model emitted in the same Turn are never read/persisted (the loop-break IS the one-at-a-time mechanism, ADR-0025). The post-loop terminal tx is short-circuited when `parked` is true (the Run is non-terminal). `db::park_on_proposal` runs ONE transaction: persist the pending `tool_calls` row, insert the sidecar `proposals` row (status pending), the guarded `running -> parked` move (`RunStatus::park`), and a `proposal_pending` Run Log milestone carrying `{proposal_id, tool_call_id, mutation_kind}`. `should_auto_approve()` returns `false` for now, so EVERY Proposal parks (ADR-0016 slice-1 empty policy). If the guarded move loses (0 rows), the proposal-pending log/event is skipped. A DB error in park is logged (`worker.park_on_proposal_failed`) and returns false (no terminal-skip). Park is a distinct, durable, non-terminal state — not `errored`.

**Key files:** `crates/core/src/worker/run.rs:151`, `crates/core/src/worker/run.rs:364`, `crates/core/src/db/mod.rs:908`, `crates/core/src/db/mod.rs:1008`

**Existing coverage:** crates/core/src/worker/run.rs::proposal_request_parks_without_terminal_tx; crates/core/src/db/mod.rs::park_on_proposal_is_atomic_and_records_events; crates/core/tests/proposal_park.rs

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F035 · Subscribers are notified the moment a Proposal parks — 🟢 impl

*As the owner, I want my attached chat surface to show the review card without polling, so that I see the Proposal to decide as soon as it parks, and again when I reconnect to a still-parked Run.*

**Expected behavior.** `proposal/pending {run_id, proposal_id}` (ProposalPendingNotification) is pushed to a Run's subscribers. On a LIVE park there is no new wire RunEvent variant — the Run Event stream stops WITHOUT a `done`; the lifecycle rides the `proposal/*` channel (ADR-0025). On `run/subscribe`, the no-hub/parked branch (subscribe.rs) sends a subscribe response with `status: "parked"` and calls `emit_pending`, which reads `db::get_pending_proposal_for_run` and pushes `proposal/pending` (no synthesized `done`). The tail forwarder, on channel close with `!saw_terminal`, also re-checks persisted status: if `Parked`, pushes `proposal/pending` (no-false-done on park). A missing proposal or read error is tolerated (WARN) — the Client still learns the park from the `parked` response status. Notifications are per-run-connection and best-effort: there is no workspace-wide proposal bus, so cross-tab fan-out is not guaranteed.

**Key files:** `crates/core/src/runs/subscribe.rs:103`, `crates/core/src/runs/subscribe.rs:116`, `crates/core/src/runs/reply.rs:61`, `crates/core/src/protocol.rs:235`

**Existing coverage:** reconnect-parked.spec.ts (reopening a parked Run rehydrates the pending proposal)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F036 · Fetch a parked Run's pending Proposal — 🟢 impl

*As the owner, I want to read the pending Proposal's kind, payload, rationale, status, and any review/plan context for a parked Run, so that my client can render the interactive review card after learning the Run is parked.*

**Expected behavior.** `proposal/get(run_id)` (handle_get in runs/proposal.rs) returns ProposalGetResult{proposal_id, run_id, mutation_kind, payload, rationale, review_context?, resolved_plan?, status}. It reads `db::get_pending_proposal_for_run`; if there is no pending proposal it errors `ProposalNotPending` (wire `proposal_not_pending`). `payload`/`rationale` are reconstructed from the originating tool call's `request_payload` (`.payload` / `.rationale`); a malformed request_payload degrades to `payload: null`/`rationale: None` rather than failing. `review_context` is present only for agent-proposable kinds that mutate an EXISTING Journal Entry/Person/Project (`carries_review_context`), surfacing the current stored fields a REPLACE would drop (ADR-0033 lamplit-desk-alignment); a missing/deleted entity, cross-thread Journal Entry, or unparseable snapshot degrades to `None`. `resolved_plan` is the per-node create/reuse/ambiguous plan computed READ-ONLY from the stored graph for `apply_intent_graph` ONLY (ADR-0042); `None`/omitted for all 13 single-entity kinds. The plan is advisory — decide re-resolves authoritatively. `update_todo` (partial MERGE) and Bookmark kinds carry no review context.

**Key files:** `crates/core/src/runs/proposal.rs:23`, `crates/core/src/runs/proposal.rs:139`, `crates/core/src/runs/proposal.rs:124`, `crates/core/src/db/mod.rs:978`, `crates/core/src/protocol.rs:169`

**Existing coverage:** crates/core/tests/proposal_review_context.rs; reconnect-parked.spec.ts (review card reappears)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F037 · Accept a Proposal applies the mutation and resumes the Run — 🟢 impl

*As the owner, I want to accept a pending Proposal, so that the proposed Workspace mutation is durably applied and the agent continues from my decision.*

**Expected behavior.** `proposal/decide` with decision="accept" routes through `decide::apply` (handle_decide injects `worker::resume` as the resume closure). On the fresh path (pending + run parked), the proposed payload is validated via `entities::validate(kind, payload)` and run-independent target refs are checked (`validate_mutation_target`), then ONE atomic `db::apply_proposal` mints the Entity, flips the proposal to `accepted` (stamps decided_at/applied_at), and resolves the tool_call with a Decision result `{decision:"accept", content: render_accept(...)}`. Returns DecideOutcome::Accepted{run_id, entity_id}; the handler frames ProposalDecideResult{status:"accepted", entity_id} and pushes `proposal/changed {status:"accepted"}`. After the apply, a single trailing resume gate fires only if the Run still reads `parked`. Exactly one entity lands (`accept_applies_once_and_resumes`). For `apply_intent_graph` (ADR-0042) a sibling path `db::apply_intent_graph_proposal` resolves+applies the graph atomically; the reported entity_id is the JE anchor (or first created entity for a JE-less direct-capture graph).

**Key files:** `crates/core/src/runs/proposal.rs:64`, `crates/core/src/decide.rs:62`, `crates/core/src/decide.rs:233`, `crates/core/src/decide.rs:348`

**Existing coverage:** crates/core/src/decide.rs::accept_applies_once_and_resumes; accept_apply_intent_graph_creates_je_and_entity_with_only_je_source; proposal-review.spec.ts (accept resumes the run, appears in library)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F038 · Reject a Proposal declines it and resumes conversationally — 🟢 impl

*As the owner, I want to reject/dismiss a pending Proposal, so that nothing is written and the agent continues the conversation rather than retrying a failure.*

**Expected behavior.** decision="reject" touches no entity store: `db::reject_proposal` flips the proposal to `rejected` and resolves the tool_call with a NORMAL (non-error) Decision result `{decision:"reject", content:"User declined this proposal.", is_error:false}` so the resumed model continues conversationally (ADR-0025). Returns DecideOutcome::Rejected{run_id}; handler frames {status:"rejected"} (no entity_id) and pushes `proposal/changed {status:"rejected"}`. The reject branch runs BEFORE the agent-proposable check, so even a (should-be-impossible) non-proposable stored kind can still be declined cleanly; its TargetMissing arm is unreachable. The trailing resume gate then re-drives resume because the Run is still parked. For `apply_intent_graph`, a decision vector that rejects EVERY node (IntentGraphOutcome::RejectedAll) is treated as a reject (nothing minted).

**Key files:** `crates/core/src/decide.rs:245`, `crates/core/src/decide.rs:439`, `crates/core/src/runs/proposal.rs:79`

**Existing coverage:** crates/core/src/decide.rs::reject_resolves_without_applying_and_resumes; reject_apply_intent_graph_writes_no_entities; proposal-review.spec.ts (dismiss rejects and resumes); rejecting an update keeps current JE

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F039 · Edit a Proposal applies my override in one step — 🟢 impl

*As the owner, I want to accept a Proposal with my own edited payload, so that the Entity that lands carries my corrections, not the model's proposed values.*

**Expected behavior.** decision="edit" requires an `edited_payload`; the applied payload is the edited one (validated via `entities::validate`) and the landed Entity holds the EDITED values (`edit_applies_edited_payload_and_resumes`). For editable UPDATE kinds (UpdateJournalEntry/Person/Project/Todo) `preserve_update_target_entity_id` re-injects the proposal's target id if the edit omits it, and rejects an edit that CHANGES the target id (Invalid "edit cannot change {target_key}") or that edits a targetless original proposal (Invalid "missing {target_key}"). A kind whose `supports_edit()` is false is rejected Invalid "does not support edit". `apply_intent_graph` does NOT support whole-payload edit — an edit is rejected loud (Invalid "apply_intent_graph does not support edit"), never silently degraded to an accept (corrections ride the per-node decision vector instead). On success: Accepted{entity_id}, proposal_changed accepted, resume re-driven. A FRESH edit missing its payload is Invalid ("edit requires edited_payload") — nothing applied, proposal stays pending + re-decidable, no resume.

**Key files:** `crates/core/src/decide.rs:320`, `crates/core/src/decide.rs:327`, `crates/core/src/decide.rs:549`, `crates/core/src/decide.rs:299`

**Existing coverage:** crates/core/src/decide.rs::edit_applies_edited_payload_and_resumes; edit_update_rejects_targetless_original_proposal; fresh_edit_without_payload_is_invalid; edit_apply_intent_graph_is_invalid; proposal-review.spec.ts (edit changes the JE then resumes); proposal-invalid-payload.spec.ts; proposal-edit-todo.spec.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F040 · A retried decide with the same key returns the prior result without re-applying — 🟢 impl

*As the owner, I want a repeated proposal/decide (same decision_idempotency_key) to be safe, so that a flaky network retry never double-applies a mutation or mints a duplicate Entity.*

**Expected behavior.** `decide::apply`/`compute_outcome` implements decide precedence (ADR-0025): (1) Keyed replay — if the proposal's recorded `decision_idempotency_key` equals the request's key, return `prior_outcome` for ANY Run status, no re-apply; (2) Already-decided without key match — return the prior result IF the Run is still parked (recovery), else NotDecidable; (3) Pending — apply/reject under the guard. A same-key accept replay returns the SAME entity_id and inserts no second entity (`same_key_replay_returns_prior_without_reapplying`). The keyed-replay and already-decided branches NEVER inspect `edited_payload`, so a payload-less `edit` retry replays/recovers rather than erroring (the edit-requires-payload check sits on the fresh path only — a load-bearing ordering subtlety). `prior_outcome` for an accepted proposal resolves entity_id via `entity_id_for_proposal` (or the payload's target id); an accepted proposal with no entity is a loud Internal.

**Key files:** `crates/core/src/decide.rs:141`, `crates/core/src/decide.rs:151`, `crates/core/src/decide.rs:192`

**Existing coverage:** crates/core/src/decide.rs::same_key_replay_returns_prior_without_reapplying; keyed_replay_after_run_advanced_does_not_re_resume; still_parked_edit_retry_without_payload_recovers

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F041 · A resume that fails after a committed decision recovers on a later decide — 🟢 impl

*As the owner, I want a Decision to never be lost if spawning the resume Worker fails, so that my accepted/rejected Proposal eventually drives the agent forward instead of wedging.*

**Expected behavior.** Apply commits BEFORE resume (ADR-0025 as-built). `worker::resume` builds the manifest line and reconstructs the transcript BEFORE the `parked -> running` flip, so a realistic pre-spawn failure (e.g. expired token) propagates as Err while the Run is still `parked`; `decide::apply` maps it to Internal, `proposal/decide` reports failure. The Run is left parked with a durably-accepted/rejected Proposal (NOT errored). A later `proposal/decide` (idempotent on key, or same already-decided proposal) takes the still-parked recovery branch: returns the prior result AND re-drives resume via the trailing gate. `mark_run_running` is self-guarded (`WHERE status='parked'`) so concurrent retries cannot double-spawn (a lost flip bails Ok). A rare POST-flip spawn failure instead finalizes the Run `errored` (the decide RPC already reported success).

**Key files:** `crates/core/src/worker/mod.rs:115`, `crates/core/src/worker/mod.rs:140`, `crates/core/src/worker/mod.rs:147`, `crates/core/src/decide.rs:105`

**Existing coverage:** crates/core/src/decide.rs::resume_failure_leaves_run_parked_and_recovers_on_retry; still_parked_recovery_returns_prior_and_re_resumes

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F042 · A stale or lost decide is reported not-decidable, not applied twice — 🟢 impl

*As the owner, I want a decide that lost a concurrent race (or targets an already-advanced Run) to fail cleanly, so that a duplicate or stale decision never applies a second time.*

**Expected behavior.** If the proposal is already decided (accepted/rejected) AND its Run has advanced off `parked`, `compute_outcome` returns NotDecidable ("proposal {id} is {status} (not pending)"); nothing re-applies and resume is NOT invoked (`stale_decide_after_concurrent_winner_is_not_decidable`). A fresh decide whose Run is NOT parked returns NotDecidable ("run is not parked"). The guarded `db::apply_proposal`/`reject_proposal` returning NotPending maps to DecideError::LostRace. The handler maps both LostRace and NotDecidable to the wire `proposal_not_pending` (-32002), Invalid to `invalid_params` (-32602), and Internal to internal (-32603). An unknown proposal id is NotDecidable ("no proposal {id}"). A stored mutation_kind that is not a known kind is a loud Internal (corrupt Core-written data), not a client Invalid.

**Key files:** `crates/core/src/decide.rs:157`, `crates/core/src/decide.rs:169`, `crates/core/src/runs/proposal.rs:90`, `crates/core/src/decide.rs:86`

**Existing coverage:** crates/core/src/decide.rs::stale_decide_after_concurrent_winner_is_not_decidable; db-layer guarded-race tests (referenced) cover genuine LostRace

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F043 · Deleting a Proposal's target before deciding resolves the Run cleanly — 🟢 impl

*As the owner, I want to delete a GTD Entity / Journal Entry that a parked Proposal targets, then decide the Proposal, so that the parked Run resolves cleanly instead of throwing an opaque internal error.*

**Expected behavior.** ADR-0033 'Delete vs. a parked Proposal': accepting an update/delete/reference Proposal whose primary TARGET row was deleted out from under it surfaces NotDecidable (-32002, "proposal target no longer exists"), not Invalid and not Internal — so the model resolves the awaited tool cleanly. `validate_mutation_target` runs run-independent ref checks BEFORE apply (so nothing is written) and maps TargetError::TargetMissing -> NotDecidable, Invalid -> Invalid. The same-thread Journal-Entry guard distinguishes 'JE row gone' (NotDecidable, delete-race) from 'JE exists but in a different thread' (Invalid, cross-thread attempt). A reference's wrong-TYPE source (a Person, not a Journal Entry) stays Invalid; a deleted reference SOURCE is NotDecidable. The apply-layer TOCTOU TargetMissing also maps to NotDecidable. In all these the proposal stays pending and resume is NOT invoked.

**Key files:** `crates/core/src/decide.rs:453`, `crates/core/src/decide.rs:517`, `crates/core/src/decide.rs:376`

**Existing coverage:** crates/core/src/decide.rs::accept_with_deleted_gtd_target_is_not_decidable; accept_with_deleted_journal_target_is_not_decidable; accept_with_wrong_thread_journal_target_is_invalid; reference_with_deleted_source_is_not_decidable_wrong_type_is_invalid

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F044 · After a decision the Run resumes from the Decision as the awaited tool result — 🟢 impl

*As the owner, I want the agent to continue the conversation seeded with my Decision, so that the model proceeds from my accept/reject/edit without re-running prior tool calls.*

**Expected behavior.** `worker::resume` rebuilds the Workflow from the Run's PERSISTED snapshot (ADR-0024 — a model/effort change between park and decide affects the NEXT run, not this one), reconstructs the transcript via `resume::reconstruct`, flips `parked -> running` (self-guarded), creates a fresh per-run hub, and spawns a `mode:"resume"` Worker driven by run_loop. `resume::reconstruct` walks the tier-2 timeline: messages become user/assistant blocks (empty assistant text segments dropped, ADR-0045); EVERY `tool_call` is attached to a trailing assistant block AND paired with a `tool_result` — its persisted result, the Decision for the parked call, or the synthesized "not executed; resubmit if still needed" placeholder for an unexecuted sibling — so the transcript is provider-valid (providers reject an orphan tool_result). `render_result_content` surfaces a Decision payload's `content`; any other tool's output passes through verbatim. The final block is the Decision tool_result. `runAgentLoopContinue` continues without re-executing prior tool calls.

**Key files:** `crates/core/src/worker/mod.rs:115`, `crates/core/src/resume.rs:87`, `crates/core/src/resume.rs:80`, `crates/core/src/resume.rs:158`

**Existing coverage:** proposal-review.spec.ts (accept/edit/reject all resume the run to a confirmation); reconnect-parked.spec.ts (parked -> running -> completed after reconnect); crates/core/tests/proposal_restart.rs

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F045 · A parked Proposal survives a Core restart and stays decidable — 🟢 impl

*As the owner, I want to quit/relaunch the app while a Proposal sits pending, so that the Proposal is still there to decide and the Run still resumes after I restart Core.*

**Expected behavior.** On boot, the recovery sweep (`db::recover_interrupted_runs`, ADR-0012) errors only Runs left `status='running'` (`UPDATE runs SET status='errored', terminal_reason='core_restarted' ... WHERE status='running'`) and appends a terminal error Run Log row for each. `parked` Runs are PRESERVED (the WHERE clause excludes them), so a parked Run stays decidable across the restart (the durable persist-then-resume is exactly why tear-down+resume was chosen over keep-alive, ADR-0025). After restart the Client reconnects via `run/subscribe`, reads `parked`, and is re-pushed `proposal/pending`; deciding then resumes via the normal path. The boot sweep prints `INKSTONE_RECOVERED {n}` and emits `core.runs_recovered`.

**Key files:** `crates/core/src/main.rs:89`, `crates/core/src/db/queries.rs:203`, `crates/core/src/db/mod.rs:1585`

**Existing coverage:** crates/core/tests/proposal_restart.rs; reconnect-parked.spec.ts (reload drops socket, Run stays parked, card returns)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F046 · A decided Proposal card survives a page reload — 🟢 impl

*As the owner, I want the settled 'Added to Journal.' / 'Applied.' indicator to persist after a refresh, so that I don't lose the visible record of a decision that is already durably stored.*

**Expected behavior.** ADR-0044 (read-path precedent of ADR-0043), superseded in projection by ADR-0045: the decided outcome rehydrates through the existing `thread/get` read as an ordered `Segment::Proposal{proposal_id, mutation_kind, status, entity_id}` positioned at its chronological run_steps slot (was MessageView.proposal). ONLY DECIDED outcomes rehydrate — the read filters to `status IN ('accepted','rejected')`. A still-`pending` Proposal does NOT rehydrate its interactive card (deferred — a parked Run resumes its review live); a `cancelled` Proposal is cleared live. No payload/rationale rides on the wire for the decided segment (the decided card reads only status + mutation_kind + entity_id, and degrades a missing payload to empty). The client reconstruction is skip-if-present so a live pending/deciding proposal wins over the settled-history view. `mutation_kind` drives the copy/routing; `status` the accepted-vs-rejected branch; `entity_id` lets the card name the created Entity and deep-link to the Library after reload.

**Key files:** `crates/core/src/runs/thread_get.rs:46`, `docs/adr/0044-decided-proposal-rehydration.md:30`, `docs/adr/0045-assistant-turn-segment-timeline.md:1`

**Existing coverage:** proposal-decided-reload.spec.ts (decided card survives reload, sits above copy button, no pending card resurrected); decided-proposal-reload.spec.ts (decided card still names the created Entity + Library link after reload, DB ground truth)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F047 · Cancelling a parked Run clears its pending Proposal — 🟢 impl

*As the owner, I want to Stop a Run that is parked awaiting a Proposal, so that I abandon the review and the pending Proposal goes away with the Run.*

**Expected behavior.** `run/cancel` on a parked Run takes the `crate::cancel` verb's PARKED branch: `db::cancel_parked_run` marks the Run `cancelled` and its pending Proposal `cancelled` (a value in the `proposals.status` CHECK) in ONE tier-2 transaction. NO Worker is signalled (a parked Run's Worker is already torn down) and the Outcome::Accepted carries `hub: None`, so `publish_cancelled` is a no-op — there is no live tail; the client settles off the authoritative cancel response (a synthesized `cancelled`) with the default 'stopped' copy. A second cancel / already-terminal Run returns `already_terminal`; an unknown run returns `unknown_run`. The cancelled Proposal is never accepted, so no post-decision confirmation appears. (Running-Run cancellation is a separate path: Core wins `running -> cancelled`, then signals the live Worker and publishes the terminal `cancelled` Run Event.)

**Key files:** `crates/core/src/cancel.rs:63`, `crates/core/src/runs/cancel.rs:39`, `crates/core/src/runs/cancel.rs:63`

**Existing coverage:** run-cancel-parked.spec.ts (clicking Stop cancels a parked run and clears its pending proposal); crates/core/src/cancel.rs parked-branch tests; crates/core/tests/proposal_cancel.rs

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F048 · Auto-approve is a Core seam that currently approves nothing — 🟡 partial

*As the owner, I want every Workspace mutation to require my explicit decision in the MVP, so that the agent never silently writes to my Workspace without review.*

**Expected behavior.** `db::should_auto_approve()` is the single auto-approve policy seam (ADR-0016/0025) and returns `false` unconditionally for now — so every `propose_workspace_mutation` parks the Run for manual approval (ADR-0016 slice-1 ships the mechanism with an empty policy table). The Worker is oblivious to auto vs manual; the Tool Result the model eventually sees carries the Decision either way, and both auto and manual would share the single atomic apply path. The forward-compatible design (a per-Workflow auto-approve table consulted by this one function) is architecture-present but data-empty; an auto-approved Proposal would resolve immediately with `{decision:"accept", auto:true}`, push `proposal/changed` (and `entity/changed`) but NO `proposal/pending`, and the Run would not park.

**Key files:** `crates/core/src/db/mod.rs:1008`, `crates/core/src/worker/run.rs:151`, `docs/adr/0016-proposal-application-policy.md:57`

**Existing coverage:** none found (the false-returning seam is exercised implicitly by every parking path; no dedicated auto-approve=true test since policy is empty)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

### Proposal Card UI

#### F049 · Proposal card dispatches single-entity vs intent-graph review — 🟢 impl

*As the owner, I want the review card to render the right surface for each proposal kind, so that a multi-entity graph gets a node-by-node queue while every other change gets a scalar accept/edit/reject card.*

**Expected behavior.** ProposalCard (ProposalCard.tsx:562) is a pure dispatcher with no hooks: when proposal.mutation_kind === 'apply_intent_graph' it returns <IntentGraphReviewCard>, otherwise <SingleEntityProposalCard>. The two decision models live in separate components so their hook order is independent. AssistantProposals (AssistantProposals.tsx:8) renders the live pending proposal for a run via useProposalForRun(runId); returns null when there is no proposal. Per-kind presentation comes from PROPOSAL_VIEWS (ProposalCard.tsx:174), a Record keyed by 11 ProposalKind strings (create/update/delete_journal_entry, reference_existing_entity_from_journal_entry, create/update_person, create/update_project, create/update_todo, apply_intent_graph). Each ProposalView supplies glyph, acceptGlyph, summary(payload), reviewCopy, accepted/rejectedCopy, accept/reject labels (+ busy variants), canEdit, and renderBody. Edge: glyphs reuse KIND_META iconography (kinds differ by glyph+label, never colour alone — a11y).

**Key files:** `apps/web/src/components/ProposalCard.tsx:562`, `apps/web/src/components/ProposalCard.tsx:174`, `apps/web/src/components/AssistantProposals.tsx:8`

**Existing coverage:** e2e proposal-captured-response.spec.ts (journal create card), intent-graph-review.spec.ts (graph card); unit ProposalCard.test.tsx

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F050 · Unrecognized proposal kind degrades to a safe fallback view — 🟢 impl

*As the owner, I want an unknown mutation_kind to render a legible card rather than crash or go blank, so that a wire string the worker shouldn't send still degrades gracefully.*

**Expected behavior.** proposalView (ProposalCard.tsx:364) gates on Object.hasOwn(PROPOSAL_VIEWS, mutationKind) rather than a bare ?? — indexing with a prototype key ('toString','constructor') would otherwise return an inherited truthy Object.prototype member and the card would crash reading .summary off a function. A non-own key resolves to fallbackView(kind) (ProposalCard.tsx:347), which renders like a generic Journal-Entry create, echoes the raw kind into reviewCopy ('Inkstone wants to create a <kind>.'), is never editable (canEdit:()=>false), and renders no detail body (renderNoBody) because the payload shape is unknown. Comment notes this is unreachable by contract (worker only proposes the listed kinds) but mutation_kind is a bare string on the wire (ADR-0014).

**Key files:** `apps/web/src/components/ProposalCard.tsx:364`, `apps/web/src/components/ProposalCard.tsx:347`

**Existing coverage:** none found (unit ProposalCard.test.tsx may cover; not confirmed)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F051 · Journal create/update/delete render mode-specific diff bodies — 🟢 impl

*As the owner, I want to see what a journal-entry proposal will create, replace, or remove, so that I can review the exact change before accepting.*

**Expected behavior.** renderJournalBody (ProposalCard.tsx:2071) shares one two-root diff selected by mode. create → 'Proposed entry' only; update → 'Current entry' (from reviewContext.current_journal_entry, if present) + 'Proposed entry'; delete → 'Current entry' only (no proposed), and when reviewContext is absent shows 'Current entry details unavailable.' Each EntrySection (ProposalCard.tsx:1982) shows Occurred (or 'Unknown'), Ended (only if present), and Body (or 'Empty'). journalBody (ProposalCard.tsx:425) flattens the body[] array, rendering text nodes as their text and entity_ref nodes as the literal '[entity_ref]'. Summaries: create → journalBody||'Untitled entry'; update → 'Update Journal Entry'; delete → 'Delete Journal Entry'. All reads go through defensive helpers (textField/objectField/arrayField/journalBody) so a null/missing/wrong-typed payload degrades rather than throws (payload is unvalidated wire — ADR-0009/0014).

**Key files:** `apps/web/src/components/ProposalCard.tsx:2071`, `apps/web/src/components/ProposalCard.tsx:1982`, `apps/web/src/components/ProposalCard.tsx:425`, `apps/web/src/components/ProposalCard.tsx:189`

**Existing coverage:** e2e proposal-captured-response.spec.ts (asserts body text + occurred_at on a create card); mutation-descriptor-verify.spec.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F052 · Person/Project/Todo proposals render their detail bodies — 🟢 impl

*As the owner, I want to see the proposed Person, Project, or Todo fields, so that I can confirm the entity is correct before adding it.*

**Expected behavior.** renderPersonBody (ProposalCard.tsx:2131) renders a 'Person' section (Name||'Unknown', Note if present, Aliases joined if any); when reviewContext.current_person exists (update_person) it stacks 'Current' + 'Replacing with' so a field present in the current body but omitted from the full-document replace stays visible (ADR-0016). renderProjectBody (ProposalCard.tsx:2170) mirrors this with Name/Outcome/Status/Note and a 'Current'+'Replacing with' stack when current_project is present. renderCreateTodoBody (ProposalCard.tsx:2189) reads the inner todo{} object: Title||'Untitled', Note/Status/Project (project_id) if present, plus person_refs rendered via personRefFields. renderUpdateTodoBody (ProposalCard.tsx:2212) shows a 'Changes' section: Todo (todo_id||'Unknown'), then only the partial keys present (Title/Note/Status/Project), set_person_refs as 'Set', add_person_refs as 'Add', and remove_person_ids joined as 'Remove'. update_person/update_project reuse the create renderers (full-document REPLACE; entity_id rides untouched, not surfaced). personRefLine (ProposalCard.tsx:2020) returns null for refs with no person_id and labels role 'waiting_on' as 'Waiting on:' else 'Related:'; personRefFields keys rows by value+occurrence counter to avoid duplicate-key collisions on identical unvalidated refs.

**Key files:** `apps/web/src/components/ProposalCard.tsx:2131`, `apps/web/src/components/ProposalCard.tsx:2170`, `apps/web/src/components/ProposalCard.tsx:2189`, `apps/web/src/components/ProposalCard.tsx:2212`, `apps/web/src/components/ProposalCard.tsx:2020`

**Existing coverage:** none found at e2e level for person/project bodies; proposal-edit-todo.spec.ts touches a create_todo card title

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F053 · Accept and reject a single-entity proposal with per-kind labels and busy states — 🟢 impl

*As the owner, I want clearly labelled accept/dismiss buttons that show progress and disable during the decide, so that I can apply or decline a change and see it is in flight.*

**Expected behavior.** SingleEntityProposalCard footer (ProposalCard.tsx:840) renders an accept button (view.acceptLabel + view.acceptGlyph; e.g. 'Add Journal Entry'/'Add Person'/'Update Todo') and a ghost reject button (view.rejectLabel; e.g. 'Dismiss'/'Keep current Todo'). decide(decision) (ProposalCard.tsx:639) sets local inFlight, records lastAttempt, and calls onDecide. While status==='deciding' both buttons are disabled (submitting = deciding || inFlight!==null) and the in-flight button swaps to a spinning Loader2 + busy label (acceptBusyLabel/rejectBusyLabel). The accept button is also disabled when !canApply. onDecide flows to decideProposal (bridge.ts:289) which guards double-submits (returns if already 'deciding'), sends proposal/decide, sets status from the result and re-subscribes for the resume tail; reject does not invalidate the library cache (creates nothing) while accept/edit do (AssistantProposals.tsx:28).

**Key files:** `apps/web/src/components/ProposalCard.tsx:840`, `apps/web/src/components/ProposalCard.tsx:639`, `apps/web/src/store/bridge.ts:289`, `apps/web/src/components/AssistantProposals.tsx:28`

**Existing coverage:** e2e proposal-captured-response.spec.ts, mutation-descriptor-verify.spec.ts, proposal-decided-reload.spec.ts (accept paths)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F054 · Journal accept/save is gated on payload validity with inline error copy — 🟢 impl

*As the owner, I want to be blocked from applying an invalid journal entry and told what is wrong, so that I don't submit a malformed timestamp or empty body.*

**Expected behavior.** journalPayloadIssue (ProposalCard.tsx:467) validates create/update journal payloads: occurred_at must match YYYY-MM-DDTHH:MM:SS (isLocalDateTime regex), ended_at if non-empty must match the same format and be lexicographically >= occurred_at ('ended at must be after occurred at'), body must be non-empty, and for update the entity_id must be non-empty. payloadIssue (accept gate, ProposalCard.tsx:620) is computed only for create/update journal kinds (GTD kinds carry no journal validation → canApply always true). canApply = payloadIssue===null disables the accept button. When payloadIssue is non-null a role='alert' destructive message renders ('Edit required fields: <issue>.'). editIssue (ProposalCard.tsx:658) re-runs the validator against the live edit-form fields to gate Save. Edge: an error status with a payloadIssue shows the issue text; an error with no issue shows "Couldn't apply. Try again."

**Key files:** `apps/web/src/components/ProposalCard.tsx:467`, `apps/web/src/components/ProposalCard.tsx:620`, `apps/web/src/components/ProposalCard.tsx:828`

**Existing coverage:** none found at e2e level (validation gate not directly exercised)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F055 · Inline Edit affordance shown only for editable kinds — 🟢 impl

*As the owner, I want an Edit button only when the proposal can be safely edited, so that I don't try to edit a delete, a reference weave, or an entity-linked journal entry.*

**Expected behavior.** canEdit = view.canEdit(bodyHasEntityRef) (ProposalCard.tsx:619). Journal create/update are editable only when the body carries no entity_ref (canEdit:(bodyHasEntityRef)=>!bodyHasEntityRef) — bodyHasEntityRef is true if either the payload OR the current journal entry has an entity_ref node (ProposalCard.tsx:592, journalBodyHasEntityRef:441). All GTD create/update kinds are always editable (canEdit:()=>true). delete_journal_entry, reference_existing_entity_from_journal_entry, apply_intent_graph, and the fallback are never editable (canEdit:()=>false). The Edit button (ProposalCard.tsx:886, variant='chip', Pencil glyph) renders only when canEdit and is disabled while submitting. openEdit (ProposalCard.tsx:663) no-ops if !canEdit; for non-GTD it re-seeds the journal form fields, for GTD it just flips editing=true (GtdEditForm seeds itself on its fresh mount).

**Key files:** `apps/web/src/components/ProposalCard.tsx:619`, `apps/web/src/components/ProposalCard.tsx:886`, `apps/web/src/components/ProposalCard.tsx:663`, `apps/web/src/components/ProposalCard.tsx:441`

**Existing coverage:** e2e mutation-descriptor-verify.spec.ts (edit on create_journal_entry), proposal-edit-todo.spec.ts (edit on create_todo)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F056 · Inline-edit a journal-entry proposal before accepting — 🟢 impl

*As the owner, I want to correct Occurred at / Ended at / Body and save the edited entry, so that the accepted journal entry reflects my correction, not the model's draft.*

**Expected behavior.** For non-GTD editable kinds the editing branch renders an inline <form> (ProposalCard.tsx:757) with EditorInput 'Occurred at', 'Ended at', and an autoFocus EditorTextarea 'Body'. editIssue gates Save (disabled + role='alert' on a validation issue). saveEdit (ProposalCard.tsx:675) bails if inFlight or status==='deciding' or editIssue!==null; builds journalPayload(editOccurredAt, editBody, editEndedAt) (trims fields, omits ended_at when blank, wraps body as a single text node), and for update prepends the preserved entity_id ({entity_id, ...editedPayload}); sets inFlight='edit', closes the form, records lastAttempt, and calls onDecide('edit', decisionPayload). Cancel (ProposalCard.tsx:802) closes the form discarding edits. decideProposal forwards edited_payload only when decision==='edit' (bridge.ts:311).

**Key files:** `apps/web/src/components/ProposalCard.tsx:757`, `apps/web/src/components/ProposalCard.tsx:675`, `apps/web/src/components/ProposalCard.tsx:451`, `apps/web/src/store/bridge.ts:311`

**Existing coverage:** e2e mutation-descriptor-verify.spec.ts ('edit changes the Journal Entry then resumes' — fills Body, asserts edited body persisted to Library)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F057 · Inline-edit GTD create proposals (Todo/Person/Project) via the deep GtdEditForm — 🟢 impl

*As the owner, I want to correct the surfaced fields of a proposed Todo/Person/Project before adding it, so that the created entity matches my intent without me re-creating it manually.*

**Expected behavior.** isGtdEditKind (proposalEdit.ts:61) selects GtdEditForm at the editing fork (ProposalCard.tsx:748). GtdEditForm (ProposalCard.tsx:1004) resolves the variant via gtdEditVariant (proposalEdit.ts:54, Object.hasOwn-gated), seeds ONE useState draft from payload on its fresh mount (re-seed-per-open), and renders exactly the surfaced fields per variant: todo_create → Title(autoFocus)/Note/Status select; person → Name(autoFocus)/Note/Aliases (comma-separated placeholder); project → Name(autoFocus)/Outcome/Note/Status select (active/on_hold/completed/dropped). Save is gated on the variant's required field via gtdRequiredEmpty (ProposalCard.tsx:959): blank title (todo_create) or blank name (person/project) disables Save. On submit GtdEditForm runs gtdOverlay (ProposalCard.tsx:976) producing the finished wire payload and calls onSave → saveGtdEdit (ProposalCard.tsx:690) commits through the same inFlight/lastAttempt/retry plumbing as the journal saveEdit. Edge: a null variant (non-GTD kind) renders nothing (state===null guard, ProposalCard.tsx:1031).

**Key files:** `apps/web/src/components/ProposalCard.tsx:1004`, `apps/web/src/components/ProposalCard.tsx:690`, `apps/web/src/lib/proposalEdit.ts:54`, `apps/web/src/lib/proposalEdit.ts:37`

**Existing coverage:** e2e proposal-edit-todo.spec.ts (edit a create_todo title, assert edited title persists, original never reaches DB); unit proposalEdit.test.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F058 · GTD edit overlays preserve unsurfaced fields and omit blank optionals (create/full-replace) — 🟢 impl

*As the owner, I want editing only the surfaced fields to leave everything else in the proposal intact, so that my correction doesn't accidentally drop or corrupt fields I never saw.*

**Expected behavior.** Each overlay clones the proposed payload (clonePayload, proposalEdit.ts:96, structuredClone; {} for null/non-object) and overwrites ONLY surfaced keys. overlayCreateTodo (proposalEdit.ts:137) preserves person_refs, source_journal_entry_id, and every unsurfaced todo{} field (project_id, due_at, defer_at, recurrence). overlayCreatePerson (proposalEdit.ts:237) preserves source_journal_entry_id; aliases split via parseAliases (trimmed, non-empty). overlayCreateProject (proposalEdit.ts:316) preserves provenance, review ritual (review_every/next_review_at/last_reviewed_at), and dates. Omit-empty (ADR-0033): a blank note/aliases/outcome DELETEs the key (create has no prior to clear, so absent is an omission not a sentinel-null). Status↔timestamp coupling (ADR-0031): only on a status CHANGE — →completed stamps completed_at + deletes dropped_at, →dropped mirrors, →active/→on_hold deletes both; unchanged status leaves stored completed_at/dropped_at intact. update_person/update_project reuse the create seed/overlay directly (full-document REPLACE; entity_id rides untouched through the clone — proposalEdit.ts:466).

**Key files:** `apps/web/src/lib/proposalEdit.ts:137`, `apps/web/src/lib/proposalEdit.ts:237`, `apps/web/src/lib/proposalEdit.ts:316`, `apps/web/src/lib/proposalEdit.ts:96`

**Existing coverage:** unit proposalEdit.test.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F059 · Editing an update_todo proposal edits the partial in place (omit-vs-sentinel split) — 🟢 impl

*As the owner, I want editing a proposed Todo update to only touch the keys the model proposed, so that declining a proposed change doesn't reach past it to erase unseen stored data.*

**Expected behavior.** update_todo is the partial kind: the payload is {todo_id, todo?:{partial}, set/add/remove person refs}. seedUpdateTodo (proposalEdit.ts:391) records titlePresent and statusPresent (whether the partial carried those keys). GtdEditForm's todo_update arm (ProposalCard.tsx:1203) shows Title only when titlePresent, Status select only when statusPresent (surfacing a select would inject an unrequested field into the partial), and always shows Note with autoFocus falling to Note when title is absent. gtdRequiredEmpty for todo_update (ProposalCard.tsx:967) gates only when titlePresent && blank title (a partial with no title key has nothing to gate, so Save stays enabled). overlayUpdateTodo (proposalEdit.ts:420) edits todo{} in place: todo_id and all three ref lists pass byte-for-byte; title/status written only when present; note always surfaced and blanking it OMITS the key (declined change, never a sentinel-null clear of unseen stored data — locked grill decision); status coupling applies only when status surfaced AND changed.

**Key files:** `apps/web/src/lib/proposalEdit.ts:391`, `apps/web/src/lib/proposalEdit.ts:420`, `apps/web/src/components/ProposalCard.tsx:1203`, `apps/web/src/components/ProposalCard.tsx:967`

**Existing coverage:** unit proposalEdit.test.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F060 · A failed decide surfaces an error and re-issues the same decision on retry — 🟢 impl

*As the owner, I want a Try again button that re-sends exactly what I last attempted, so that a transient failure doesn't lose my accept/edit/reject choice.*

**Expected behavior.** When status==='error' decideProposal's catch (bridge.ts:337) set status to 'error'. The card shows a role='alert' message — the payloadIssue text when present, else "Couldn't apply. Try again." (ProposalCard.tsx:828). The footer swaps the accept button for a 'Try again' button (RotateCcw, ProposalCard.tsx:841) wired to retry (ProposalCard.tsx:644), which replays lastAttempt: re-issuing onDecide with the stored decision and, for an edit, its stored editedPayload. Retry is gated on what it will re-send: reject is always allowed; a stored edit is allowed only if its editedPayload is defined; a plain accept is gated on canApply (ProposalCard.tsx:848). The effect at ProposalCard.tsx:631 clears inFlight whenever status leaves 'deciding'. lastAttempt persists across deciding→error so retry re-issues the same decision.

**Key files:** `apps/web/src/components/ProposalCard.tsx:841`, `apps/web/src/components/ProposalCard.tsx:644`, `apps/web/src/store/bridge.ts:337`, `apps/web/src/components/ProposalCard.tsx:631`

**Existing coverage:** none found at e2e level (error/retry path not exercised by the listed specs)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F061 · A decided proposal collapses to an Applied/dismissed pill with entity name + Library link — 🟢 impl

*As the owner, I want a settled proposal to show its outcome, the entity name, and a deep-link to the Library, so that I can confirm what happened and jump to the created/updated entity (the undo answer).*

**Expected behavior.** When status is 'accepted' or 'rejected' the single-entity card renders an inline pill (ProposalCard.tsx:698) wearing ToolCallRow chrome (ADR-0045) rather than the bordered Card, carrying data-proposal=run_id and data-proposal-status. Accepted shows a Check + view.acceptedCopy (e.g. 'Added to Journal.'/'Added Person.'); rejected shows view.rejectedCopy (e.g. 'Dismissed.'/'Kept current Todo.') with no check and no link (a reject created nothing). The aria-live='polite' span announces the copy. On accept only, DecidedLibraryLink (ProposalCard.tsx:516, withTitle) resolves proposal.entity_id from the warm useLibraryItems cache and renders the entity's current title (libraryItemTitle) plus a 'View in Library' button (ArrowUpRight) that navigates to /library/$kind with the entity id. Edge: DecidedLibraryLink renders null when entityId is undefined or not (yet) in the cache (still loading / Core unreachable / since-deleted), degrading to the generic decided copy. entity_id is set from the proposal/decide result (bridge.ts:328) and absent on a reject.

**Key files:** `apps/web/src/components/ProposalCard.tsx:698`, `apps/web/src/components/ProposalCard.tsx:516`, `apps/web/src/store/bridge.ts:328`

**Existing coverage:** e2e proposal-decided-reload.spec.ts (asserts 'added to journal' pill); the entity-name/Library-link is not directly asserted

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F062 · A decided proposal's outcome survives a page reload — 🟢 impl

*As the owner, I want the settled proposal card to reappear after a refresh, so that my history of applied/dismissed changes isn't lost on reload.*

**Expected behavior.** PendingProposal.status includes accepted/rejected (chat.ts:135) and a rehydrated decided proposal carries entity_id from the proposal SEGMENT (chat.ts:130). rehydrateDecidedProposal (chat.ts:286) reconstructs the settled record cold from thread/get without payload/rationale/resolved_plan (the decided card reads only status + mutation_kind, and every payload reader degrades a missing payload). It no-ops if a proposal already exists for the run (chat.ts:288), and attaches the proposal segment. The card therefore re-renders the accepted/rejected pill after a cold reload. Edge: only the settled outcome rehydrates — no pending card is resurrected.

**Key files:** `apps/web/src/store/chat.ts:286`, `apps/web/src/store/chat.ts:130`, `apps/web/src/store/chat.ts:135`

**Existing coverage:** e2e proposal-decided-reload.spec.ts (accepts a journal proposal, reloads, asserts the accepted pill rehydrates, no pending card resurrected, and the card sits above the copy button)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F063 · Intent-graph proposal renders a node-by-node review queue — 🟢 impl

*As the owner, I want to review each extracted entity (Person/Project/Todo) as its own row with a disposition badge, so that I can accept or reject items individually before one atomic apply.*

**Expected behavior.** IntentGraphReviewCard (ProposalCard.tsx:1326) renders the resolved_plan as a <ul> of GraphNodeRow items keyed by handle, with the header counting '<n> items to review' (journal-entry anchor is not a plan node). Each row (ProposalCard.tsx:1628) shows the entity glyph (KIND_META[node.type].icon), the label (or handle fallback), and a disposition Badge via DISPOSITION_BADGE (ProposalCard.tsx:1296): create → 'New'(Plus, secondary), reuse → 'Existing'(Check, secondary), ambiguous → 'Needs disambiguation'(TriangleAlert, destructive). Accept/Reject are icon toggle buttons (Check/X) with aria-pressed reflecting stage and sr-only 'Accept/Reject <label>' names; rows carry data-graph-node=handle and data-node-stage. The default staging accepts every acceptable node and rejects ambiguous ones, so a blind Apply accepts everything resolvable (stageFor, intentGraphReview.ts:72). The whole graph is ONE proposal/park/atomic commit (ADR-0042); sequential review is purely client-side via a local StagingBuffer in component state (not the chat store).

**Key files:** `apps/web/src/components/ProposalCard.tsx:1326`, `apps/web/src/components/ProposalCard.tsx:1628`, `apps/web/src/lib/intentGraphReview.ts:72`, `apps/web/src/components/ProposalCard.tsx:1296`

**Existing coverage:** e2e intent-graph-review.spec.ts ('accept-all commit lands all four entities' asserts '3 items to review', node rows, New badge); unit intentGraphReview.test.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F064 · Ambiguous graph nodes are reject-only and block accept-all — 🟢 impl

*As the owner, I want a node matching more than one existing entry to be un-acceptable for now, so that I'm not silently committing the wrong link before a disambiguation picker exists.*

**Expected behavior.** isAcceptable (intentGraphReview.ts:28) returns false for disposition==='ambiguous'. stageFor defaults an ambiguous node to 'reject' (intentGraphReview.ts:73) and setStage (intentGraphReview.ts:79) ignores an 'accept' request on an unacceptable node. In the row, the Accept toggle is disabled when !acceptable with title 'Needs disambiguation — cannot accept yet' (ProposalCard.tsx:1802). When the plan has any ambiguous node (hasAmbiguous, intentGraphReview.ts:65) the card shows an advisory note: 'Some items match more than one existing entry. They can only be dismissed for now — disambiguation is coming soon.' (ProposalCard.tsx:1529). This is the #181 deferred picker. acceptAll/rejectAll write a total, explicit vector (ambiguous → reject) so the commit is unambiguous.

**Key files:** `apps/web/src/lib/intentGraphReview.ts:28`, `apps/web/src/lib/intentGraphReview.ts:73`, `apps/web/src/components/ProposalCard.tsx:1802`, `apps/web/src/components/ProposalCard.tsx:1529`

**Existing coverage:** unit intentGraphReview.test.ts; not exercised by the e2e specs (graph fixtures use create dispositions)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F065 · Inline-edit a create node's recognition fields before applying — 🟢 impl

*As the owner, I want to correct a freshly-recognized Todo/Person/Project's surfaced fields in its row, so that the minted entity carries my correction via edited_fields.*

**Expected behavior.** A create node (not reuse/ambiguous, not re-pointed) shows a Pencil that expands the row inline into GraphNodeEditForm (ProposalCard.tsx:1838), keyed one-open-at-a-time via editingHandle. The form surfaces only the recognition surface — Todo: Title/Note; Person: Name/Aliases/Note; Project: Name/Outcome/Note (no status, no defer/due). It seeds from the committed draft (re-open) or the node's proposed entities[] fields (seedNodeDraft, intentGraphReview.ts:200). Save is gated on the required field via draftRequiredEmpty (intentGraphReview.ts:232). saveEdit (ProposalCard.tsx:1443) commits the draft to the drafts buffer, forces the node to ACCEPT (an edit applies only to a kept node), and collapses the row; Cancel discards the working draft. The collapsed row then shows the edited label (draftLabel) and, when the draft actually changes a field (buildEditedFields!==undefined) on an accepted node, replaces the disposition badge with 'Edited' (data-node-edited='true'). Edge: opening + Save with no change stores a draft but still sends a plain accept, so the badge stays 'New' (ProposalCard.tsx:1692). buildEditedFields (intentGraphReview.ts:274) emits the minimal patch: changed fields set, blanked clearable optionals as null (Core removes the key), unchanged omitted; undefined when nothing changed.

**Key files:** `apps/web/src/components/ProposalCard.tsx:1838`, `apps/web/src/components/ProposalCard.tsx:1443`, `apps/web/src/lib/intentGraphReview.ts:200`, `apps/web/src/lib/intentGraphReview.ts:274`

**Existing coverage:** e2e intent-graph-review.spec.ts ('editing a create node sends edited_fields' — edits Todo title, asserts Edited badge + data-node-edited, edited title persisted, original absent); unit intentGraphReview.test.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F066 · Near-match create nodes default to reusing the existing entity with an escape hatch — 🟢 impl

*As the owner, I want a proposed-new entity that closely matches an existing one to default to reusing it, so that I don't mint a duplicate, but can still force a new one.*

**Expected behavior.** repointFor (intentGraphReview.ts:47) computes the effective re-point: an explicit RepointBuffer entry wins (string id re-points, null = 'create new instead'); with no entry a create node with EXACTLY ONE near-match defaults to that entity's id (default-to-existing). Zero or 2+ near-matches → no default (2+ defer to the #181 picker). Object.hasOwn-gated to harden against prototype-key handles. A re-pointed node (ProposalCard.tsx:1664) wears an 'Existing «<targetLabel>»' badge (reuse tone), carries data-node-repoint=<id>, is NOT editable (a reuse is linked-to, not minted), and offers a 'Create new instead' button (createNewInstead, ProposalCard.tsx:1458, sets null). A single-near-match node sent back to New offers 'Use existing «<label>»' (reuseExisting, ProposalCard.tsx:1462, clears the override + drops any edit draft + forces accept). 2+ near-matches surface an advisory 'Matches existing: <labels>' with no auto-pick (ProposalCard.tsx:1777). buildDecisions makes entity_id (re-point) win over edited_fields per node — mutually exclusive (intentGraphReview.ts:350).

**Key files:** `apps/web/src/lib/intentGraphReview.ts:47`, `apps/web/src/components/ProposalCard.tsx:1664`, `apps/web/src/components/ProposalCard.tsx:1458`, `apps/web/src/lib/intentGraphReview.ts:350`

**Existing coverage:** e2e intent-graph-review.spec.ts ('a near-twin Project defaults to the existing entity; Apply mints no duplicate' and "'Create new instead' overrides the near-match and mints the new Project"); unit intentGraphReview.test.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F067 · Rejecting a graph target a Todo links to surfaces a downgrade notice before Apply — 🟢 impl

*As the owner, I want to be warned when rejecting a Project/Person drops a kept Todo's link, so that I understand the Todo will land standalone before I commit.*

**Expected behavior.** downgradeNotices (intentGraphReview.ts:403) inspects parsed graph links (parseGraphLinks, intentGraphReview.ts:443 — only todo_project/todo_person/journal_ref kinds survive; journal_ref is skipped for downgrades). For every todo_project/todo_person link whose from-Todo is staged accept and whose to-target is staged reject, it emits a notice naming the Todo and dropped target: todo_project → '“<todo>” will be created without its project link to “<target>”.', todo_person → '“<todo>” will be created without its link to “<target>”.'. The card renders these as a bulleted list with a TriangleAlert per item (ProposalCard.tsx:1536). Each notice is keyed by todoHandle+targetHandle so a Todo losing both its project AND a person link renders two distinct notices without a React key collision (DowngradeNotice doc, intentGraphReview.ts:375).

**Key files:** `apps/web/src/lib/intentGraphReview.ts:403`, `apps/web/src/lib/intentGraphReview.ts:443`, `apps/web/src/components/ProposalCard.tsx:1536`

**Existing coverage:** e2e intent-graph-review.spec.ts ('rejecting the Project lands the Todo standalone' asserts the 'without its project link' notice + DB standalone Todo); unit intentGraphReview.test.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F068 · Apply commits the staged graph as one decision vector; Dismiss all rejects everything — 🟢 impl

*As the owner, I want one Apply button that commits my per-node choices atomically, and one Dismiss-all, so that the whole reviewed graph applies (or declines) in a single decision.*

**Expected behavior.** The footer (ProposalCard.tsx:1565) shows an Apply button labelled 'Apply <acceptedCount> item(s)' (acceptedCount = nodes staged accept) and a ghost 'Dismiss all'. commit (ProposalCard.tsx:1416) builds the per-node decisions[] via buildDecisions(plan, buffer, drafts, entities, repoints) (intentGraphReview.ts:341 — one entry per node carrying its stage, an accepted create node folding in its edited_fields correction or near-match entity_id re-point) and calls onDecide(decision, undefined, decisions). When every node is staged reject (allRejected, intentGraphReview.ts:121) the decision is 'reject' (Core declines the whole graph) and the Apply label becomes the reject label; otherwise 'accept'. rejectEverything (ProposalCard.tsx:1427) stages rejectAll and commits a reject vector with no edited_fields. Apply is disabled while submitting or when plan.length===0; the in-flight button spins (Loader2 + acceptBusyLabel/rejectBusyLabel). decideProposal forwards decisions only when defined (bridge.ts:312). The decided graph collapses to an 'Applied.'/'Dismissed.' pill with a DecidedLibraryLink to the anchor entity (withTitle=false), keeping 'Applied.' copy because the accepted-node count isn't carried on a rehydrated decided graph (ProposalCard.tsx:1380).

**Key files:** `apps/web/src/components/ProposalCard.tsx:1416`, `apps/web/src/lib/intentGraphReview.ts:341`, `apps/web/src/components/ProposalCard.tsx:1565`, `apps/web/src/components/ProposalCard.tsx:1380`

**Existing coverage:** e2e intent-graph-review.spec.ts (all four tests: 'apply 3 items'/'apply 2 items' clicks → 'applied' + DB ground-truth on entities/links); unit intentGraphReview.test.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F069 · Graph staging resets when the proposal identity changes within a reused card — 🟢 impl

*As the owner, I want a second graph proposal in the same run to start with fresh, empty staging, so that a prior graph's per-node toggles can't leak into the next and submit an unintended decision.*

**Expected behavior.** The card is keyed by run_id (not proposal_id), so a multi-step Run that parks a SECOND apply_intent_graph proposal after a resume reuses the same mounted card with a fresh proposal_id. An effect keyed on proposal.proposal_id (ProposalCard.tsx:1369) resets buffer, drafts, editingHandle, and repoints to empty. Without this, because the staging buffer is keyed by graph-local handles (ephemeral model labels that collide across extractions), a prior graph's toggles could leak into the next. A separate effect clears inFlight whenever status leaves 'deciding' (ProposalCard.tsx:1375).

**Key files:** `apps/web/src/components/ProposalCard.tsx:1369`, `apps/web/src/components/ProposalCard.tsx:1375`

**Existing coverage:** none found (the multi-graph-per-run reset is not exercised by the listed e2e specs)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

### Library / Entity CRUD

#### F070 · Browse the Library nav: chat return, search, GTD views, and per-kind collections with counts — 🟢 impl

*As the owner, I want a left nav listing Today, Inbox, Waiting, Review, and each entity kind with live counts, so that I can jump to any collection or GTD view and see how many items each holds at a glance.*

**Expected behavior.** LibraryNav (apps/web/src/components/library/LibraryNav.tsx) renders, top-down: a 'Chat' link to '/', a 'Search' button that calls openCommand() with a ⌘K kbd hint, then Today (Link to '/library' with activeOptions exact), Inbox (badge = inboxTodos(items).length), Waiting (waitingTodos length), Review (projectsForReview length), then one Link per kind in KIND_ORDER = journal_entry, person, project, todo, bookmark (libraryItems.ts:174). Each kind row shows meta.icon + meta.plural + counts[kind] from libraryItemKindCounts (libraryItems.ts:312). Counts derive from useLibraryItems data, defaulting to [] when undefined. Settings gear navigates to /settings/models. Kind slugs come from KIND_META (journal→'journal', person→'people', project→'projects', todo→'todos', bookmark→'bookmarks').

**Key files:** `apps/web/src/components/library/LibraryNav.tsx:24`, `apps/web/src/lib/libraryItems.ts:174`, `apps/web/src/lib/libraryItems.ts:196`, `apps/web/src/lib/libraryItems.ts:312`

**Existing coverage:** none found (no e2e/unit test for LibraryNav specifically; counts/derivations are exercised indirectly)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F071 · Browse a per-kind collection list with kind-specific sorting and live count — 🟢 impl

*As the owner, I want to open /library/$kind and see all items of that kind sorted sensibly, so that I can scan my People, Projects, Todos, Journal, or Bookmarks.*

**Expected behavior.** EntityCollection (EntityCollection.tsx:61) filters useLibraryItems data to e.kind===kind, shows header with meta.plural, the count (ofKind.length), and a SearchField. Sort is compareForKind (EntityCollection.tsx:28): journal_entry by occurredAt desc then id; person alphabetical by title; project by PROJECT_STATUS_RANK (active<on_hold<completed<dropped) then recency desc; todo active-first then soonest dueAt (missing due sorts last via U+FFFF sentinel) then recency desc; bookmark by recency desc. Journal entries render grouped by day via JournalEntryGroups/groupJournalEntriesByDay (newest day first, within-day by occurredAt asc); todos render as TodoRow; everything else as EntityRow inside a <ul>. The route ($kind.tsx) resolves the slug via libraryItemKindForSlug; an unknown slug renders an 'Unknown collection' EmptyState with a 'Back to Today' button.

**Key files:** `apps/web/src/components/library/EntityCollection.tsx:28`, `apps/web/src/components/library/EntityCollection.tsx:61`, `apps/web/src/routes/library/$kind.tsx:18`, `apps/web/src/lib/libraryItems.ts:620`

**Existing coverage:** tests/e2e/src/library-crud.spec.ts (asserts collection regions show created/edited rows); library-live-only.spec.ts:47 (empty collection); unknown-slug path: none found

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F072 · Search/filter items within a collection — 🟢 impl

*As the owner, I want a search box that filters the current collection by title and subtitle, so that I can find one item without scrolling.*

**Expected behavior.** EntityCollection holds a `query` state; when query.trim() is non-empty it runs searchLibraryItems(ofKind, query) (libraryItems.ts:662) which ranks: title prefix=100, word-boundary=80, substring=60, subtitle substring=30, ties broken by recency; an empty query falls back to the kind sort. If items.length===0 after a non-empty query, a 'No matches' EmptyState (Search icon) shows the trimmed query. SearchField has aria-label `Search {plural}` and an onClear that resets the query.

**Key files:** `apps/web/src/components/library/EntityCollection.tsx:73`, `apps/web/src/components/library/EntityCollection.tsx:142`, `apps/web/src/lib/libraryItems.ts:662`

**Existing coverage:** none found (searchLibraryItems likely unit-tested elsewhere; no e2e for in-collection search)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F073 · See a loading skeleton while a collection loads — 🟢 impl

*As the owner, I want placeholder rows while the Library reads from Core, so that the list doesn't flash empty during load.*

**Expected behavior.** While useLibraryItems isPending, EntityCollection renders <EntitySkeleton rows={8} /> (EntityCollection.tsx:123). EntitySkeleton (EntitySkeleton.tsx) renders an animate-pulse <ul data-testid='entity-skeleton' aria-hidden> of N decorative rows, each a glyph box + two text-line placeholders mirroring real EntityRow metrics. Default rows=6 but the collection passes 8.

**Key files:** `apps/web/src/components/library/EntitySkeleton.tsx:2`, `apps/web/src/components/library/EntityCollection.tsx:123`

**Existing coverage:** none found (no test asserts the skeleton via data-testid)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F074 · See teaching empty states and a load-error state — 🟢 impl

*As the owner, I want a helpful message when a collection is empty or fails to load, so that I know whether to add items, accept a proposal, or reload.*

**Expected behavior.** EntityCollection branches (EntityCollection.tsx:123-147): isError → EmptyState tone='danger' 'Couldn't load {plural}' with reload guidance; ofKind.length===0 → 'No {plural} yet'. The empty copy differs by creatability: a creatable kind (onNew defined) reads 'Use New {label} to add one, or accept a proposal suggested from chats'; a non-creatable kind reads '{plural} appear here as Inkstone notices them in your chats and you accept the Proposal'. Today/index has its own 'Your library is empty' heading. useLibraryItems returns [] (not error) when Core is unreachable (catch in useLibraryItems.ts:51), so a web preview shows empty, not error.

**Key files:** `apps/web/src/components/library/EntityCollection.tsx:123`, `apps/web/src/lib/hooks/useLibraryItems.ts:49`

**Existing coverage:** tests/e2e/src/library-live-only.spec.ts:25 (Today empty state, no preview rows), :47 (empty People collection teaches)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F075 · Recognize each item by its glyph and row (kind by glyph+label, never colour alone) — 🟢 impl

*As the owner, I want each row to show a kind glyph (or Person initials), title, and subtitle, so that I can distinguish kinds and items accessibly.*

**Expected behavior.** EntityGlyph (EntityGlyph.tsx) renders Person as round initials (first+last initial uppercased, '?' fallback) and every other kind as its KIND_META icon in a rounded box; aria-hidden, with sm/md/lg sizes. EntityRow (EntityRow.tsx:16) is a selectable button: glyph + libraryItemTitle + libraryItemSubtitle, aria-current when selected, optional trailing slot. TodoRow (EntityRow.tsx:90) is special: a read-only TodoStatusGlyph (CircleCheck=Completed, CircleSlash=Dropped, Circle=Active, each aria-labeled), strike-through title when resolved, project name or 'No project' as context, and a DueChip (Overdue→AlertTriangle icon+label, else the date) — overdue uses icon+label not colour alone (todoIsOverdue from libraryItems.ts:492). Subtitles come from libraryItemSubtitle (libraryItems.ts:250): journal=occurredAt, person=note or 'Person', project=outcome or status label, todo=`Due YYYY-MM-DD` or note/status, bookmark=URL host or 'Bookmark'.

**Key files:** `apps/web/src/components/library/EntityGlyph.tsx:19`, `apps/web/src/components/library/EntityRow.tsx:16`, `apps/web/src/components/library/EntityRow.tsx:90`, `apps/web/src/lib/libraryItems.ts:250`

**Existing coverage:** apps/web/src/components/library/EntityRow.test.tsx; EntityCollection.test.tsx (unit)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F076 · View an entity's detail inspector with relations as deep links — 🟢 impl

*As the owner, I want selecting a row to open a detail rail showing the entity's fields and related items, so that I can inspect an item and navigate to its connections.*

**Expected behavior.** Selecting a row sets ?id (and for a collection constrains to that kind); LibraryLayout (route.tsx:45) resolves `selected` from useLibraryItems data and mounts EntityDetail keyed by id in the right rail (aria-label `{title} details`). EntityDetail (EntityDetail.tsx:52) dispatches by kind to Todo/Person/Project/JournalEntry/Bookmark bodies via the shared InspectorShell (header = EntityGlyph + title + `{label} · {subtitle}` + Edit chip). Person body shows aliases, note, Waiting-on (active waiting_on todos), Tasks, Projects (peopleForProject/projectsForPerson derivations) and Mentioned-in. Project body shows StatusBadge, outcome, note, review line (next/last review via formatDay), a progressbar (done/total via projectProgress), People and Todos. Todo body shows status/due/defer/recurrence/completed/dropped badges, note, Project, linked People with role badges (PersonRefRow), Mentioned-in. Journal body shows occurred/ended-at and the body with EntityRefChip tokens (clickable when target resolves, plain span otherwise). Related/chip clicks navigate to that entity's /library/$kind?id route. Rail width widens to 520px for journal_entry, else 400px (route.tsx:72).

**Key files:** `apps/web/src/components/library/EntityDetail.tsx:52`, `apps/web/src/components/library/EntityDetail.tsx:105`, `apps/web/src/routes/library/route.tsx:45`, `apps/web/src/lib/libraryItems.ts:332`

**Existing coverage:** apps/web/src/components/library/EntityDetail.test.tsx; tests/e2e/src/library-crud.spec.ts (detail rail visibility); library-live-only.spec.ts:59 (Person detail live-only fields)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F077 · Follow an entity's 'Captured from' provenance footer to its source — 🟢 impl

*As the owner, I want a 'Captured from' footer linking an extracted entity back to its source Journal Entry or chat Thread, so that I can see where an item came from and revisit the original context.*

**Expected behavior.** CapturedFrom (EntityDetail.tsx:408, ADR-0030) renders only when entity.source resolves to a working link. A journal_entry source links to that entry IF it's still in allEntities (else renders nothing — no dead link); a thread source links to /thread/$threadId with the thread title (or 'Untitled thread'). User-authored entities have no source so no footer. The footer is a hairline-topped ProvenanceFrame labeled 'Captured from'; the title is rendered in signature magenta (text-primary) with the createdAt date and an ArrowUpRight. Source is parsed by parseSource (entityCodec.ts:65): journal_entry_id wins over thread fields; empty-string ids are treated as absent so no dead link renders. Bookmark detail intentionally passes no allEntities and renders no footer (a Bookmark is always a direct user create). Single-hop by design: a JE-sourced entity links to the JE, which carries its own thread provenance.

**Key files:** `apps/web/src/components/library/EntityDetail.tsx:408`, `apps/web/src/lib/entityCodec.ts:65`, `apps/web/src/lib/libraryItems.ts:23`, `crates/core/src/runs/entity.rs:54`

**Existing coverage:** tests/e2e/src/entity-provenance.spec.ts (extract→follow Captured-from to the source JE, single-hop); EntityDetail.test.tsx

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F078 · Create a Todo directly from the Library rail — 🟢 impl

*As the owner, I want a 'New Todo' button that opens a blank inline editor and writes the Todo directly on Save, so that I can capture a task without an agent proposal.*

**Expected behavior.** $kind.tsx gates the 'New {label}' button on CREATABLE_KINDS (todo is included). Clicking it navigates with ?new=true; route.tsx mounts CreateEditor→TodoEditor (mode='create') in the rail (aria-label `New Todo`). TodoEditor (TodoEditor.tsx:57) collects title/note/status/project/due/defer/Waiting-on/recurrence. Save is blocked while titleEmpty, anchorMissing (Repeats on but the anchor date absent — shows a hint), or intervalInvalid (Repeats on with a non-positive-integer interval — shows 'Enter a whole number of 1 or more'). buildCreateParams (entityCodec.ts:452) OMITS empty optionals (Core rejects explicit-null on create), sets completed_at/dropped_at when status≠active, emits person_refs only when a waiting person is linked, and recurrence only when recurActive (toggled on AND anchor date present). On success the route navigates to ?id of the new entity and the Library re-reads (useEntityMutation invalidates ['library-items']). Direct user create writes created_by='user', no Proposal, no entity_source row (mutate.rs apply). A submit guard in EntityEditorFrame ignores Enter/double-submit while saving.

**Key files:** `apps/web/src/components/library/TodoEditor.tsx:57`, `apps/web/src/lib/entityCodec.ts:452`, `apps/web/src/routes/library/$kind.tsx:53`, `crates/core/src/mutate.rs:42`

**Existing coverage:** tests/e2e/src/library-crud.spec.ts:18 (create a Todo via rail → DB ground truth created_by='user'); crates/core mutate.rs create tests; TodoEditor.test.tsx

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F079 · Edit a Todo via the inspector (partial-diff update with sentinel-null clears) — 🟢 impl

*As the owner, I want to edit a Todo's fields and save changes directly, so that I can update a task without an agent proposal.*

**Expected behavior.** InspectorShell 'Edit Todo' opens TodoEditor (mode='edit') prefilled via todoDraftFromVm. buildUpdateParams (entityCodec.ts:483) builds update_todo as a DIFF of next vs prev: only changed scalars go in the `todo` partial; a cleared optional sends sentinel `null` (note/project_id/due_at/defer_at/recurrence), and a status change re-stamps/clears completed_at/dropped_at via null. Person refs rebuild as a set via set_person_refs only when the waiting_on link changed. Returns null when nothing changed (editor closes without a write). update_todo is a partial MERGE on Core (omitted fields preserved); a null on a non-clearable field (title/status) is rejected as Invalid (entities.rs validate_partial_todo_data; mutate.rs test null_on_non_clearable_field_is_rejected). The hand-built diff is intentionally NOT routed through schema encode (sentinel-null is a validator-only extension the advertised schema rejects).

**Key files:** `apps/web/src/lib/entityCodec.ts:483`, `apps/web/src/components/library/EntityDetail.tsx:244`, `crates/core/src/entities.rs:857`, `crates/core/src/mutate.rs:213`

**Existing coverage:** tests/e2e/src/library-crud.spec.ts:49 (edit Todo persists across reload); entity-codec-roundtrip.spec.ts:23 (sentinel-null clears one field, preserves rest); mutate.rs update_todo_null_clears_due_at

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F080 · Create and edit a Person directly (full-document replace) — 🟢 impl

*As the owner, I want to add a Person with name/aliases/note and edit them inline, so that I can maintain my people without an agent proposal.*

**Expected behavior.** PersonEditor (PersonEditor.tsx) collects name (required; Save blocked while nameEmpty), comma-separated aliases (parseAliases trims/drops empties), and note. buildPersonCreate (entityCodec.ts:590) omits empty optionals; buildPersonUpdate (entityCodec.ts:598) is a full-document REPLACE — name always sent, note/aliases only when non-empty, cleared optionals simply OMITTED (omit ≡ null under replace), and returns null when nothing changed. Core validate_person requires a non-empty name and validates aliases as a non-empty-string array (mutation.rs person_core). A full-replace update_person dropping a null-valued optional clears it (mutate.rs update_person_null_clears_note). On success the route opens ?id of the affected Person.

**Key files:** `apps/web/src/components/library/PersonEditor.tsx:26`, `apps/web/src/lib/entityCodec.ts:590`, `crates/core/src/mutation.rs:176`, `crates/core/src/entities.rs:495`

**Existing coverage:** tests/e2e/src/library-crud.spec.ts:188 (edit Person full-replace keeps name, swaps note); mutate.rs update_person_changes_field / update_person_null_clears_note; PersonEditor.test.tsx

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F081 · Create and edit a Project directly (full-replace with verbatim-data overlay) — 🟢 impl

*As the owner, I want to add or edit a Project's name/outcome/note/status inline, so that I can manage projects without an agent proposal.*

**Expected behavior.** ProjectEditor uses buildProjectCreate (entityCodec.ts:758) — omits empty optionals, never sends review_every (Core injects the default review ritual), stamps completed_at/dropped_at on non-active status. buildProjectUpdate (entityCodec.ts:770) CLONES the verbatim stored project.data (carried by parseProject), deletes entity_id, overlays name/outcome/note/status, re-stamps terminal timestamps ONLY on a status change (so original completion/drop dates aren't overwritten), then drops undefined/null keys so server-managed review_every/due_at/defer_at survive the full-replace; returns null when nothing changed. Core validate_project_data enforces the status↔timestamp invariant and a status enum of active/on_hold/completed/dropped; an explicit null status is rejected (status optional-but-not-clearable). update_project clearing outcome via null removes the key (mutate.rs update_project_null_clears_outcome).

**Key files:** `apps/web/src/lib/entityCodec.ts:758`, `apps/web/src/lib/entityCodec.ts:770`, `crates/core/src/mutation.rs:205`, `crates/core/src/entities.rs:541`

**Existing coverage:** tests/e2e/src/library-crud.spec.ts:240 (edit status→on_hold persists); entity-codec-roundtrip.spec.ts:98 (server-managed field survives an edit); mutate.rs update_project_null_clears_outcome; ProjectEditor.test.tsx

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F082 · Create and edit a Journal Entry directly (full-replace body + reference weave) — 🟢 impl

*As the owner, I want to write/edit a Journal Entry's occurred/ended times and body, and attach an entity reference, so that I can journal and link to People/Projects/Todos without an agent proposal.*

**Expected behavior.** JournalEntryEditor (JournalEntryEditor.tsx) opens in the widened 520px rail. Save is blocked while occurredAt empty or the body is empty (buildBody yields no nodes and no staged new chip). Create emits create_journal_entry with occurred_at (and ended_at when set) and body of text/entity_ref nodes; update emits a FULL-REPLACE update_journal_entry (a removed chip is simply absent). datetime-local minute-precision is reconciled via emitWallClock so an untouched stored-seconds value isn't silently re-stamped. Adding a reference (edit only) is a SEPARATE reference_existing_entity_from_journal_entry mutation: the picker (AddReferenceField) offers Person/Project/Todo only (REFERENCEABLE_KINDS; never a Journal Entry/Bookmark), stages exactly one bare placeholder chip, and is gated to chip-FREE entries ('One reference per entry for now'). On Save with a staged chip AND a date edit, the editor first awaits update_journal_entry (to not lose the date), then awaits the reference mutation, then drops the staged placeholder. Core rejects ref_id on a reference body node and mints one ref_id, so the body carries exactly one placeholder.

**Key files:** `apps/web/src/components/library/JournalEntryEditor.tsx:37`, `apps/web/src/lib/entityCodec.ts:948`, `apps/web/src/lib/entityCodec.ts:1041`, `crates/core/src/entities.rs:404`

**Existing coverage:** tests/e2e/src/library-crud.spec.ts:355 (edit then delete a JE); journal-entry-ref.spec.ts:26 (clickable inline ref from a reference proposal); JournalEntryEditor.test.tsx

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F083 · Create and edit a Bookmark directly (ADR-0036, user-only kind) — 🟢 impl

*As the owner, I want to save a Bookmark with title/url/tags/note and edit it inline, so that I can keep links the agent never authors.*

**Expected behavior.** BookmarkEditor (BookmarkEditor.tsx) collects title (required; Save blocked while titleEmpty), url, comma-separated tags (parseTags dedupes/trims), and note. buildBookmarkCreate (entityCodec.ts:675) omits empty optionals; buildBookmarkUpdate (entityCodec.ts:684) is a full-replace (title always, url/note/tags when non-empty, cleared optionals omitted), returning null when nothing changed. Bookmark is a user-CRUD-only kind: create_bookmark/update_bookmark/delete_bookmark are NOT agent-proposable (mutation.rs ProposableMutation excludes them; TryFrom returns NotProposable). Core stores url opaque (no scheme validation); the inspector guards the href so only http/https/mailto render as a clickable link (bookmarkHref, libraryItems.ts:285) — a javascript:/data: or scheme-less url shows as plain text. The Bookmark detail renders no relations and no Captured-from footer.

**Key files:** `apps/web/src/components/library/BookmarkEditor.tsx:26`, `apps/web/src/lib/entityCodec.ts:675`, `apps/web/src/lib/libraryItems.ts:285`, `crates/core/src/mutation.rs:187`

**Existing coverage:** tests/e2e/src/library-crud.spec.ts:412 (create), :443 (edit persists across reload), :496 (delete); mutate.rs bookmark_crud_via_entity_path; BookmarkEditor.test.tsx

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F084 · Delete any entity via a two-step inline confirm — 🟢 impl

*As the owner, I want a non-modal Delete affordance that asks me to confirm before removing an entity, so that I never delete by accident and approval stays deliberate.*

**Expected behavior.** InspectorShell footer (EntityDetail.tsx:193) shows a destructive 'Delete {label}' button; clicking sets confirmingDelete and reveals a confirm sentence (per kind: e.g. 'Delete this Todo?', 'Delete this Project? Its Todos lose their project.') with Cancel/Delete. Cancel runs del.reset() and clears confirmingDelete with no write. Confirm sends entity/mutate with DELETE_KIND[entity.kind] (total map: delete_todo/person/project/journal_entry/bookmark) and { entity_id }; on success the route drops ?id so the rail returns empty and the Library re-reads. While pending the button reads 'Deleting…' and both buttons disable. On error a role='alert' line shows the WsError message or 'Couldn't delete. Try again.' Core hard-deletes the row; revisions cascade via FK, and deleting a Project unsets project_id on its owning Todos (Core cascade). A vanished target is mapped to Invalid (client-correctable concurrent delete), not Internal.

**Key files:** `apps/web/src/components/library/EntityDetail.tsx:141`, `apps/web/src/components/library/EntityDetail.tsx:193`, `crates/core/src/mutate.rs:101`, `crates/core/src/runs/entity.rs:81`

**Existing coverage:** tests/e2e/src/library-crud.spec.ts:102 (delete Person), :135 (Project cascade unsets project_id), :281 (delete Todo), :315 (cancel — no write), :496 (delete Bookmark); mutate.rs delete_person_removes_row

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F085 · Receive validation errors on an invalid entity write without partial state — 🟢 impl

*As the owner, I want an invalid create/update/delete to be rejected with a clear error and nothing written, so that my workspace never ends up in a half-applied or schema-violating state.*

**Expected behavior.** entity/mutate (runs/entity.rs:81) resolves mutation_kind once via MutationKind::from_wire (unknown→Invalid -32602), runs entities::validate(kind,payload) (Invalid→-32602), runs run-independent target-ref checks (a vanished/wrong-type target → Invalid), then applies in one atomic tx via apply_user_mutation (mutate.rs:42), mapping MutateError::Invalid→-32602 and Internal→-32603. The user path additionally REJECTS source_journal_entry_id on create_person/project/todo with the specific message 'source_journal_entry_id is not supported on direct user creates' (the Library is anchor-less). Field validators enforce: required non-empty name/title, status enums, the status↔timestamp invariant, recurrence rules (positive interval, unit/anchor enums, at-most-one end via until/after_count, and an anchor whose date is present), and per-kind unsupported-field rejection. mark_project_reviewed/update_bookmark/delete_bookmark against a wrong-type target are Invalid. Editors surface the squashed WsError message (useEntityMutation.ts uses runPromiseExit + Cause.squash so callers read the real WsError, not 'An error has occurred') as a role='alert' line; on failure no navigation/close happens.

**Key files:** `crates/core/src/runs/entity.rs:81`, `crates/core/src/mutate.rs:49`, `crates/core/src/entities.rs:22`, `apps/web/src/lib/hooks/useEntityMutation.ts:24`

**Existing coverage:** crates/core/src/entities.rs validate unit tests (reject unsupported kind/field/missing/non-uuid id); mutate.rs null_on_non_clearable_field_is_rejected, create_with_source_journal_entry_id_is_rejected, *_wrong_type_are_invalid; no e2e for the UI error line

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F086 · Library reads live entities per kind via entity/list — 🟢 impl

*As the owner, I want the Library to load all my entities of each kind from Core, so that my collections, nav counts, and Today reflect real data.*

**Expected behavior.** useLibraryItems (useLibraryItems.ts:15) fetches journal_entry/todo/person/project/bookmark concurrently (Effect.all concurrency 2) via client.listEntities, then maps each row through the codec parse* functions into view models. Core's entity/list handler (runs/entity.rs:18) returns EntityRow with data, created_at/updated_at, resolved refs, person_refs, and the flat provenance source (EntitySourceView with thread_id/thread_title or journal_entry_id). The codec defensively defaults sparse data (e.g. title→'Untitled', name→'Unnamed') so a thin row can't crash the inspector, but parseJournalEntry THROWS on a missing/malformed occurred_at or empty/invalid body (strict live-row validation below the read boundary). When Core is unreachable the query catches and returns [] (web preview shows an empty Library rather than erroring).

**Key files:** `apps/web/src/lib/hooks/useLibraryItems.ts:15`, `crates/core/src/runs/entity.rs:18`, `apps/web/src/lib/entityCodec.ts:93`, `apps/web/src/lib/entityCodec.ts:323`

**Existing coverage:** tests/e2e/src/library-live-only.spec.ts (live-only reads, no preview rows); entity-codec-roundtrip.spec.ts (round-trip through the live read)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F087 · Only manually-creatable kinds expose a 'New' affordance — 🟢 impl

*As the owner, I want the 'New {label}' button and blank-create rail to appear only for kinds I can author directly, so that I'm not offered to create something the agent must propose.*

**Expected behavior.** Both the per-collection 'New' button ($kind.tsx:53) and the rail mount of the blank editor (route.tsx:79) gate on the single shared CREATABLE_KINDS set (libraryItems.ts:188), which currently contains all five kinds: todo, person, project, journal_entry, bookmark. CreateEditor (route.tsx:121) dispatches the ?new=1 rail to the correct per-kind editor in create mode. ?new closes back to the bare collection via closeCreate (search:{}). Because the set is the single source of truth, the button and the rail can never drift; if a future kind is removed from the set, its collection empty state switches to the 'accept the Proposal' copy and no New button renders.

**Key files:** `apps/web/src/lib/libraryItems.ts:188`, `apps/web/src/routes/library/$kind.tsx:53`, `apps/web/src/routes/library/route.tsx:79`, `apps/web/src/routes/library/route.tsx:121`

**Existing coverage:** tests/e2e/src/library-crud.spec.ts (New Todo / New Bookmark buttons drive create); no test pins the gating set itself

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

### GTD Views

#### F088 · Inbox shows only active, unorganized todos — 🟢 impl

*As the owner, I want to see active todos that have no project, no due date, and no people, so that I can triage everything I captured but haven't organized yet.*

**Expected behavior.** The /library/inbox route renders DerivedTodoView with select=inboxTodos (inbox.tsx:15-26). inboxTodos (libraryItems.ts:534-545) returns items where kind==='todo' AND status==='active' AND projectId==null AND dueAt==null AND personRefs.length===0, sorted by recency descending (newest first). A todo with any project, any due date, OR any person ref (waiting_on OR related) is excluded — note the predicate excludes on ANY personRef regardless of role. Completed/dropped todos never appear (status gate). Header shows the literal count (DerivedTodoView.tsx:45-49). Edge case: when the filtered list is empty, an EmptyState with title 'Inbox zero' and the no-unsorted description is shown (inbox.tsx:20-21, DerivedTodoView.tsx:66-71). e2e seeds 'Buy stamps' (bare active todo) and asserts it appears while 'Wait for Alice's draft' (waiting) and 'Cut over the API' (project) do not.

**Key files:** `apps/web/src/routes/library/inbox.tsx:10-35`, `apps/web/src/lib/libraryItems.ts:534-545`, `apps/web/src/components/library/DerivedTodoView.tsx:34-88`, `tests/e2e/src/gtd-views.spec.ts:28-34`

**Existing coverage:** tests/e2e/src/gtd-views.spec.ts ('GTD views derive Inbox, Waiting, Review and Todo detail from live data') asserts inbox includes 'Buy stamps' and excludes organized todos

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F089 · Waiting view shows active todos with a waiting_on person ref — 🟢 impl

*As the owner, I want to see active todos where I'm waiting on someone, so that I can follow up on things blocked on other people.*

**Expected behavior.** The /library/waiting route renders DerivedTodoView with select=waitingTodos (waiting.tsx:14-27). waitingTodos (libraryItems.ts:552-561) returns items where kind==='todo' AND status==='active' AND personRefs.some(ref => ref.role==='waiting_on'), sorted by recency descending. Edge case: a todo whose only person ref has role 'related' does NOT appear (the some() requires role==='waiting_on'). Edge case: defer_at does not remove a todo from this view (no defer filter; documented in the function doc comment libraryItems.ts:548-551). A todo can be in both Waiting and a project (no project exclusion). Empty state title 'Nothing pending' (waiting.tsx:20). e2e seeds TODO_WAITING (waiting_on Alice) which appears, and TODO_IN_PROJECT (related Bob) which is excluded.

**Key files:** `apps/web/src/routes/library/waiting.tsx:10-35`, `apps/web/src/lib/libraryItems.ts:552-561`, `tests/e2e/src/gtd-views.spec.ts:36-44`

**Existing coverage:** tests/e2e/src/gtd-views.spec.ts asserts Waiting includes 'Wait for Alice's draft' and excludes the related-only 'Cut over the API' and bare 'Buy stamps'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F090 · Project Review lists active/on-hold projects whose review is due — 🟢 impl

*As the owner, I want a focused queue of projects due for a periodic check-in, so that I can step through and review each one OmniFocus-style.*

**Expected behavior.** The /library/review route renders ProjectReviewView (review.tsx:12-19). projectsForReview (libraryItems.ts:568-581) returns projects where kind==='project' AND (status==='active' OR status==='on_hold') AND nextReviewAt!=null AND nextReviewAt<=now (local wall-clock string compare), sorted soonest/most-overdue first by nextReviewAt ascending. Completed and dropped projects are never reviewable. A project with no nextReviewAt is excluded. The header subtitle reads 'Active and on-hold projects due for a periodic check-in.' (ProjectReviewView.tsx:97-99) and shows the queue count (line 93-95). Edge case: empty queue shows EmptyState 'All caught up' (ProjectReviewView.tsx:157-166). e2e seeds 'API migration' active project with next_review_at far in the past (2000-01-01) and asserts it appears in Review.

**Key files:** `apps/web/src/routes/library/review.tsx:8-27`, `apps/web/src/lib/libraryItems.ts:568-581`, `apps/web/src/components/library/ProjectReviewView.tsx:41-198`, `tests/e2e/src/gtd-views.spec.ts:46-51`

**Existing coverage:** tests/e2e/src/gtd-views.spec.ts asserts 'API migration' appears in Review; project-review.spec.ts also exercises the queue

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F091 · Review queue is a stable session snapshot that doesn't reshuffle mid-review — 🟢 impl

*As the owner, I want the review queue order to stay fixed while I work through it, so that the cursor never jumps as I mark things reviewed or complete todos.*

**Expected behavior.** ReviewQueue (ProjectReviewView.tsx:114-198) snapshots the due-project ids ONCE on first non-empty render into local state snapshotIds (lines 128-132) and never re-derives mid-session. The snapshot ids are resolved against current rows so in-session edits/review stamps reflect, but the order and membership are frozen; a project marked reviewed (whose next_review_at jumps forward, leaving projectsForReview) STAYS visible-but-done in the queue (lines 123-127). reviewedIds and sessionDone are lifted to ReviewQueue (lines 154-155) so they survive the per-project remount (FocusedProject is keyed by project.id, line 179). On RE-ENTRY (remount via navigation away and back) the live ['library-items'] query refetches and the snapshot re-derives from scratch. e2e: after marking 'Quarterly planning' reviewed the row stays with the action disabled/'Reviewed'; navigating away and back shows 'All caught up'.

**Key files:** `apps/web/src/components/library/ProjectReviewView.tsx:114-198`, `tests/e2e/src/project-review.spec.ts:43-95`, `tests/e2e/src/project-review.spec.ts:167-185`

**Existing coverage:** project-review.spec.ts ('mark a due project reviewed' and 'focused review queue steps between projects') assert the snapshot keeps a reviewed project in place and re-derives on re-entry

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F092 · Mark a project reviewed advances its review schedule — 🟢 impl

*As the owner, I want to mark the focused project reviewed with one click, so that its next review is scheduled and it leaves the due queue.*

**Expected behavior.** FocusedProject's 'Mark reviewed' button fires useEntityMutation with mutation_kind 'mark_project_reviewed' and an {entity_id}-only payload (ProjectReviewView.tsx:241-248). The client sends NO review data; Core recomputes (ADR-0034). In db/apply.rs apply_mark_project_reviewed (lines 502-582): loads current project data, stamps last_reviewed_at = now_local, sets next_review_at = advance_review_at_local (the NEXT Sunday 20:00 STRICTLY after now — entities.rs:976-983, so a project reviewed on a Sunday lands on the FOLLOWING Sunday and cannot re-surface same-day), and NORMALIZES review_every to {interval:1, unit:'week'}. The merged data is re-validated via validate_project_data (defense in depth, apply.rs:557) and a new entity_revision is appended (apply.rs:572-581). On success the mutation invalidates ['library-items'] (useEntityMutation.ts:38-39) and onReviewed advances the cursor and adds the id to reviewedIds (ProjectReviewView.tsx:190-193). The button then shows 'Reviewed' and is disabled (lines 279-284). e2e asserts DB ground truth: last_reviewed_at set, next_review_at advanced past the seed and ending T20:00:00, review_every.unit='week', and exactly one revision appended.

**Key files:** `apps/web/src/components/library/ProjectReviewView.tsx:241-284`, `crates/core/src/db/apply.rs:502-582`, `crates/core/src/entities.rs:976-1008`, `docs/adr/0034-mark-project-reviewed-write-path.md:11-44`

**Existing coverage:** tests/e2e/src/project-review.spec.ts ('mark a due project reviewed → it leaves Review and Core advances next_review_at') asserts the DB review fields and revision

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F093 · Mark reviewed is rejected for completed/dropped projects — 🟢 impl

*As the owner, I want the system to refuse marking a terminal project reviewed, so that a stale or buggy client can't corrupt review state.*

**Expected behavior.** apply_mark_project_reviewed reads the project status (defaulting an absent status to 'active', mirroring create-time) and if it is 'completed' or 'dropped' returns ApplyError::InvalidMutation 'a {status} project is not reviewable' (db/apply.rs:520-530), which surfaces as -32602 InvalidParams on the user path (mutate.rs:92-93). Also, mark_project_reviewed against a non-project entity_id is Invalid (entities.rs validation / mutation_target check; tested mark_project_reviewed_wrong_type_is_invalid in mutate.rs:786). A concurrently-deleted target surfaces TargetMissing (apply.rs:514, 569-570) which on the user path maps to Invalid 'target entity no longer exists' (mutate.rs:101-103). The UI never offers the action for a terminal project (Review only lists active/on-hold), so this is a defense-in-depth guard. Note: the validator also rejects extra fields like next_review_at in the payload (entities.rs:1887-1895 entity_id_only validation).

**Key files:** `crates/core/src/db/apply.rs:520-530`, `crates/core/src/mutate.rs:84-105`, `docs/adr/0034-mark-project-reviewed-write-path.md:95-105`, `crates/core/src/entities.rs:1879-1895`

**Existing coverage:** crates/core/src/mutate.rs unit tests (mark_project_reviewed_wrong_type_is_invalid:786; mark_project_reviewed_user_path_stamps_review:626); no e2e covers the completed/dropped rejection path

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F094 · Focused review shows cadence, last-reviewed date, and a project counter — 🟢 impl

*As the owner, I want to see how often a project is reviewed and when it was last reviewed, so that I have context while deciding whether it's still moving.*

**Expected behavior.** FocusedProject header shows 'Project {position+1} of {total}' (ProjectReviewView.tsx:288-290), the cadence label, and either 'Last reviewed {YYYY-MM-DD}' (sliced from lastReviewedAt) or 'Never reviewed' when absent (lines 291-296). reviewCadenceLabel (libraryItems.ts:589-595) reads the verbatim stored data.review_every {interval, unit}: returns 'Every {unit}' when interval===1 (e.g. 'Every week') else 'Every {interval} {unit}s' (e.g. 'Every 2 weeks'); returns null (label hidden) when review_every is absent or malformed. The project outcome, when present, renders as a subtitle (lines 298-300). e2e seeds 'Alpha rollout' with review_every weekly and last_reviewed_at and asserts 'Project 1 of 2', 'Every week' are visible. Note: a project with no review_every (e.g. 'Quarterly planning') shows no cadence label until reviewed (which normalizes it to weekly).

**Key files:** `apps/web/src/components/library/ProjectReviewView.tsx:200-308`, `apps/web/src/lib/libraryItems.ts:589-595`, `tests/e2e/src/project-review.spec.ts:143-148`

**Existing coverage:** tests/e2e/src/project-review.spec.ts ('focused review queue steps between projects') asserts 'Project 1 of 2' and 'Every week'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F095 · Step forward and back through the review queue — 🟢 impl

*As the owner, I want to navigate to the previous/next project in the review queue, so that I can move at my own pace and revisit a project I already passed.*

**Expected behavior.** FocusedProject renders Previous/Next chevron buttons (ProjectReviewView.tsx:258-275) wired to onPrev/onNext which call goTo(index±1), clamped to [0, queue.length-1] (lines 173-174). The Previous button is disabled at position 0; the Next button is disabled at the last position (total-1) (lines 262, 270). The counter 'Project X of N' updates accordingly. Marking a project reviewed also auto-advances the cursor via onReviewed→goTo(index+1) (lines 190-193). e2e clicks 'Next project' to move from 'Alpha rollout' (1 of 2) to 'Beta cleanup' (2 of 2).

**Key files:** `apps/web/src/components/library/ProjectReviewView.tsx:169-197`, `apps/web/src/components/library/ProjectReviewView.tsx:258-275`, `tests/e2e/src/project-review.spec.ts:162-165`

**Existing coverage:** tests/e2e/src/project-review.spec.ts ('focused review queue steps between projects') clicks Next and asserts the second project and counter

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F096 · Complete a project's next-action todo inline during review — 🟢 impl

*As the owner, I want to tick off a finished todo without leaving the review, so that I can clear next actions while reviewing the project.*

**Expected behavior.** ReviewTodoRow (ProjectReviewView.tsx:338-423) shows a status circle button; clicking it (when not already done/pending) fires useEntityMutation with mutation_kind 'update_todo' setting status:'completed' and completed_at:localNowString() (lines 361-373). On success onCompleted adds the id to the lifted sessionDone set (line 371). The row renders as done (line-through, CircleCheck) when status==='completed' OR mutation.isSuccess (optimistic, before refetch) OR doneThisSession (lines 358-359) — so a just-ticked todo stays VISIBLE (parent filter includes sessionDone ids, lines 237-239) and CHECKED on revisit (grill Q13). The circle is disabled once done/pending (line 381). FocusedProject lists only active todos plus session-completed ones (todosForProject filtered, lines 237-239). Edge case: a project with no active todos shows 'No active todos. Is this project still moving, or done?' (lines 310-313). e2e completes 'Ship the alpha' and polls the DB for status==='completed'.

**Key files:** `apps/web/src/components/library/ProjectReviewView.tsx:310-423`, `apps/web/src/lib/libraryItems.ts:332-334`, `tests/e2e/src/project-review.spec.ts:151-160`

**Existing coverage:** tests/e2e/src/project-review.spec.ts ('focused review queue steps between projects') clicks 'mark todo complete' and asserts DB status completed

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F097 · Today highlights todos due soon, overdue first — 🟢 impl

*As the owner, I want to see todos that are due within a few days, most urgent first, so that I know what needs me right now when I open the app.*

**Expected behavior.** TodayOverview (TodayOverview.tsx:74-118) computes due = dueSoonTodos(data). dueSoonTodos (libraryItems.ts:501-518) returns active todos (kind==='todo' AND status==='active') whose dueAt date portion (slice(0,10)) is <= now+withinDays (default 3 days) horizon day, sorted by dueAt ascending so overdue/earliest first. This is a to-the-day notion — a todo due later today still counts. The 'Due soon' section renders only when due.length>0, with a count and a 'View all' affordance navigating to /library/$kind todos (lines 94-117). The header summary reads '{n} due soon' or, when none, 'Everything's clear. Nothing needs you right now.' (lines 78, 89-91). Each row is a TodoRow; overdue todos show a destructive 'Overdue' DueChip with an icon (EntityRow.tsx:53-64, 102, 136-138). todoIsOverdue (libraryItems.ts:492-494) = active AND dueAt!=null AND dueAt<now.

**Key files:** `apps/web/src/components/library/TodayOverview.tsx:74-118`, `apps/web/src/lib/libraryItems.ts:501-518`, `apps/web/src/lib/libraryItems.ts:492-494`, `apps/web/src/components/library/EntityRow.tsx:53-64`

**Existing coverage:** today-overview.spec.ts covers header/In focus/Recently captured but does NOT seed a due todo, so the Due soon section is not asserted in e2e

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F098 · Today shows in-focus projects with progress and recently captured items — 🟢 impl

*As the owner, I want to see my active projects with progress and my most recent captures, so that I get an at-a-glance overview of my workspace.*

**Expected behavior.** TodayOverview renders an 'In focus' section (top 4 active/on-hold projects) when any exist: activeProjectItems (libraryItems.ts:520-528) filters projects with status active OR on_hold, sorted by recency desc, sliced to 4 (TodayOverview.tsx:76, 120-155). Each project shows a progress bar from projectProgress(data, project) = done/total of its todos (libraryItems.ts:642-651; done counts status==='completed'), rendered as a percentage width and '{done}/{total}' or 'No todos' when total===0 (lines 124-148). 'Recently captured' shows recentlyCapturedItems(data, 6) — all kinds sorted by recency desc, limit 6 (libraryItems.ts:432-437). Loading shows a skeleton; an error shows EmptyState 'Couldn't load your library'; a fully empty library shows 'Your library is empty' with a 'Start a chat' CTA (TodayOverview.tsx:26-72). e2e seeds a project/todo/person and asserts the header, In focus project, and Recently captured rows.

**Key files:** `apps/web/src/components/library/TodayOverview.tsx:26-166`, `apps/web/src/lib/libraryItems.ts:520-528`, `apps/web/src/lib/libraryItems.ts:642-651`, `tests/e2e/src/today-overview.spec.ts:24-79`

**Existing coverage:** today-overview.spec.ts ('Today renders its header and the In focus section') asserts header, In focus project, and Recently captured rows

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F099 · Selecting an item on Today opens its detail rail without leaving — 🟢 impl

*As the owner, I want to click any item on Today and see its detail beside the overview, so that I can inspect things without losing the overview.*

**Expected behavior.** TodayOverview's open(id) navigates to /library with search {id} (TodayOverview.tsx:21-24), setting ?id so the shared Library rail renders the entity's detail while Today stays mounted. Due-soon TodoRows (onSelect=open), in-focus project buttons (onClick=open(project.id)), and recently-captured EntityRows (onSelect=open) all route through this (lines 109-113, 130, 159-160). e2e clicks a 'Jordan Lee' person row and asserts the URL becomes /library?id=..., the Today heading remains visible, and the detail complementary 'Jordan Lee details' renders.

**Key files:** `apps/web/src/components/library/TodayOverview.tsx:21-24`, `apps/web/src/components/library/TodayOverview.tsx:107-163`, `tests/e2e/src/today-overview.spec.ts:81-121`

**Existing coverage:** today-overview.spec.ts ('selecting an entity on Today opens its detail rail in place') asserts ?id navigation and the detail rail

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F100 · Derived todo views handle loading, error, selection, and live count — 🟢 impl

*As the owner, I want the Inbox/Waiting views to load gracefully and let me open a row's detail, so that I can work the list even while data loads or fails.*

**Expected behavior.** DerivedTodoView (DerivedTodoView.tsx:14-89) is the shared frame for Inbox and Waiting. While useLibraryItems isPending it shows EntitySkeleton (rows=6) and no count; on isError it shows a tone='danger' EmptyState 'Couldn't load {title}'; on empty it shows the per-view emptyTitle/emptyDescription; otherwise a list of TodoRow (lines 57-84). The live count next to the title (items.length) renders only when not pending and not error (lines 45-49). Selecting a row calls onSelect(id) which (per route) navigates with search {id} so the shared rail renders detail (inbox.tsx:23-25, waiting.tsx:23-25); the selected row is highlighted via selected={todo.id===selectedId}. Each TodoRow shows a read-only status glyph (completed/dropped/active), the title (line-through when resolved), the owning project name or 'No project', and a due chip when dueAt is set (EntityRow.tsx:90-142). The view is wrapped in a region labelled by its title for accessibility (line 38). Note: editing from the row is deferred per ADR-0032; the row only opens detail.

**Key files:** `apps/web/src/components/library/DerivedTodoView.tsx:14-89`, `apps/web/src/components/library/EntityRow.tsx:66-142`, `apps/web/src/routes/library/inbox.tsx:22-26`

**Existing coverage:** Loading/error/empty states have no dedicated e2e; the populated-list + selection path is covered indirectly by gtd-views.spec.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F101 · Todo person references (role waiting_on/related) ride on the todo and drive views — 🟢 impl

*As the owner, I want todos to carry their linked people with a GTD role, so that Waiting derives correctly and detail shows who's involved.*

**Expected behavior.** Per ADR-0032, entity/list emits person_refs:[{person_id, role}] on each todo row (entity.rs handle_list:49-53, mapping db person_refs to TodoPersonRefView). The web view model parses these into Todo.personRefs:TodoPersonRef[] with role 'waiting_on'|'related' (libraryItems.ts:124-146, 100). Derivations consume them: waitingTodos requires a waiting_on ref (libraryItems.ts:558); inboxTodos requires personRefs.length===0 (line 542); todosForPerson filters by personId and optional role (lines 337-348); peopleForProject derives Project→People as the union of person_refs across the project's todos (lines 355-375); projectsForPerson derives Person→Projects via the person's todos' project_ids (lines 381-399) — Project↔Person is never stored directly (ADR-0032 consequences). The Todo detail rail renders a linked-person row as a button labelled by name + a role chip ('Alice Waiting on'). Edge case: absent/empty person_refs means no person involvement (consumers treat it as optional).

**Key files:** `crates/core/src/runs/entity.rs:49-53`, `apps/web/src/lib/libraryItems.ts:124-146`, `apps/web/src/lib/libraryItems.ts:337-399`, `docs/adr/0032-gtd-relations-on-entity-list.md:11-43`

**Existing coverage:** tests/e2e/src/gtd-views.spec.ts asserts the Todo detail shows 'Alice Waiting on' role chip and the derived Waiting/Inbox membership

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F102 · A todo's owning project is derived from project_id and shown in detail/rows — 🟢 impl

*As the owner, I want to see and navigate to the project a todo belongs to, so that I can move from a task to its bigger outcome.*

**Expected behavior.** project_id lives in the Todo's data JSON (ADR-0031/0032) and is parsed to Todo.projectId. projectForTodo (libraryItems.ts:421-429) resolves the owning Project by id, used by TodoRow to show the project name as the row context or 'No project' (EntityRow.tsx:103-104, 133-134) and by the Todo detail rail to render a link button to the project. todosForProject (libraryItems.ts:332-334) gives the inverse (a project's todos), used by projectProgress and the Review view's next-actions list. A todo with at most one owning project (ADR-0031). e2e seeds TODO_IN_PROJECT with project_id=PROJECT_MIGRATION and asserts the Todo detail shows an 'API migration' button.

**Key files:** `apps/web/src/lib/libraryItems.ts:421-429`, `apps/web/src/lib/libraryItems.ts:332-334`, `apps/web/src/components/library/EntityRow.tsx:103-134`, `tests/e2e/src/gtd-views.spec.ts:65-73`

**Existing coverage:** tests/e2e/src/gtd-views.spec.ts asserts the Todo detail renders the owning Project link button

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F103 · Completing a todo transitions it to completed and removes it from active views — 🟢 impl

*As the owner, I want to mark a todo complete and have it leave my active lists, so that finished work stops cluttering Inbox/Waiting/Today.*

**Expected behavior.** update_todo with status:'completed' + completed_at performs a three-way merge in db/apply.rs (the update path, lines ~304-388). The transition is gated: the recurrence successor / completion-specific effects fire only on the prior_status==='active' → 'completed' transition, computed from the pre-merge stored status (apply.rs:310-313, 380-381), so re-saving an already-completed todo never re-fires. After completion, TodoStatus is 'completed' so dueSoonTodos/inboxTodos/waitingTodos (all gate on status==='active') drop it, and TodoRow renders it line-through with a CircleCheck glyph (EntityRow.tsx:67-75, 101, 125-126). The Review view keeps a session-completed todo visible-but-checked (see review-complete-todo-inline). TODO_STATUS_LABEL maps active/completed/dropped to display strings (libraryItems.ts:306-310).

**Key files:** `crates/core/src/db/apply.rs:304-388`, `apps/web/src/lib/libraryItems.ts:306-310`, `apps/web/src/components/library/EntityRow.tsx:66-142`, `apps/web/src/lib/libraryItems.ts:534-561`

**Existing coverage:** tests/e2e/src/project-review.spec.ts asserts an inline completion writes status='completed' to the DB; status-glyph rendering has no dedicated e2e

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F104 · Completing a recurring todo spawns its next occurrence — 🟢 impl

*As the owner, I want a repeating todo to regenerate itself when I complete it, so that recurring obligations keep showing up without re-entry.*

**Expected behavior.** On the active→completed transition, if the merged data has a recurrence rule, spawn_recurrence_successor runs in the SAME tx (db/apply.rs:374-388, 390-434). recurrence::next_occurrence (recurrence.rs:41-117) advances both defer_at and due_at by interval×unit (civil arithmetic, anchored to the stored local dates; recurrence.rs:5-13), decrements the rule's afterCount, and returns no successor when the end condition is reached (afterCount<=1 gate at recurrence.rs:55-58, or next anchor > until at lines 78-91). The successor carries title/note/project_id/recurrence forward, resets status to active, clears completed_at, and sets the advanced dates (apply.rs:419-433); it is validated before write (defense in depth, apply.rs:434). Edge cases: month overflow clamps to month-end; a runaway interval that would exceed the 4-digit year bound yields no successor rather than a panic (recurrence.rs:118-202). This is a status-transition side effect that feeds new active todos back into the GTD views.

**Key files:** `crates/core/src/recurrence.rs:41-202`, `crates/core/src/db/apply.rs:374-434`, `apps/web/src/lib/libraryItems.ts:117-122`

**Existing coverage:** crates/core/src/recurrence.rs unit tests (advances_each_unit, clamps_month_overflow_to_month_end, and more); ADR-0039 governs the behavior; no GTD-view e2e exercises the successor

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F105 · Project status (active/on_hold/completed/dropped) gates which projects surface — 🟢 impl

*As the owner, I want only live projects to appear in focus and review, so that completed or dropped projects don't reappear as work.*

**Expected behavior.** ProjectStatus is active|on_hold|completed|dropped (libraryItems.ts:75). activeProjectItems (Today 'In focus') includes only active OR on_hold (libraryItems.ts:520-528). projectsForReview includes only active OR on_hold with a due nextReviewAt (lines 568-581) — completed/dropped are never reviewable. PROJECT_STATUS_LABEL maps each status to a display string (lines 299-304); libraryItemSubtitle falls back to the status label for a project with no outcome (lines 256-257). create_project injects status:'active' when absent and seeds a weekly review ritual for active projects (db/apply.rs:59-126). The mark_project_reviewed guard also enforces the active/on_hold reviewability rule server-side (see review-mark-reviewed-guard).

**Key files:** `apps/web/src/lib/libraryItems.ts:75-96`, `apps/web/src/lib/libraryItems.ts:299-304`, `apps/web/src/lib/libraryItems.ts:520-528`, `crates/core/src/db/apply.rs:59-126`

**Existing coverage:** Active-status gating is exercised via today-overview.spec.ts (In focus) and gtd-views/project-review specs (Review queue); on_hold/completed/dropped gating has no dedicated e2e

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

### Todo Recurrence

#### F106 · Define a recurrence rule on a Todo via the Library rail editor — 🟢 impl

*As the owner, I want toggle Repeats and set how often a Todo repeats (interval + unit + anchor) in the Todo editor, so that a routine obligation is tracked as a single repeating Todo instead of being re-entered each cycle.*

**Expected behavior.** In TodoEditor.tsx a 'Repeats' checkbox (toggleRecurs, line 88) reveals 'Every' (number input, min=1), 'Unit' (select of Minutes/Hours/Days/Weeks/Months/Years from UNIT_OPTIONS), and 'Anchor' (select of Defer date / Due date from ANCHOR_OPTIONS). Toggling Repeats ON defaults recurAnchor to 'due_at' when a due date exists else 'defer_at' (line 92) so the emitted rule's anchor date is present. On save, buildRecurrence (entityCodec.ts:437) emits snake_case {interval:Number(recurInterval), unit:recurUnit, anchor:recurAnchor} into todo.recurrence, and recurActive (line 428) gates emission on recurs && anchor-date-present. Edge: the rule is only emitted when the anchor date exists; with no project/people it still emits. The rule lives inside entities.data JSON (ADR-0037), no new column.

**Key files:** `apps/web/src/components/library/TodoEditor.tsx:86`, `apps/web/src/components/library/TodoEditor.tsx:203`, `apps/web/src/lib/entityCodec.ts:427`, `apps/web/src/lib/entityCodec.ts:437`, `docs/adr/0037-todo-recurrence-rule.md:29`

**Existing coverage:** tests/e2e/src/todo-recurrence.spec.ts (create a recurring Todo via the rail editor → recurrence persists)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F107 · Editor blocks save when the chosen anchor's date is absent — 🟢 impl

*As the owner, I want be prevented from saving a repeat whose anchor date (defer/due) is not set, with a clear inline message, so that I don't silently lose the rule to a Core rejection.*

**Expected behavior.** TodoEditor computes anchorMissing = draft.recurs && !recurAnchorDatePresent(draft) (line 98); recurAnchorDatePresent (entityCodec.ts:423) returns true only when due_at→dueDay set or defer_at→deferDay set. When anchorMissing, canSave is false (line 136) and an inline hint renders: 'Set the {due|defer} date to save this repeat.' (lines 267-272). submit() early-returns if anchorMissing (line 107). This mirrors Core's anchor-presence invariant so the trap is caught client-side; Core still owns the rest of validation (entityCodec.ts:417-422 comment).

**Key files:** `apps/web/src/components/library/TodoEditor.tsx:98`, `apps/web/src/components/library/TodoEditor.tsx:136`, `apps/web/src/components/library/TodoEditor.tsx:267`, `apps/web/src/lib/entityCodec.ts:423`

**Existing coverage:** none found (e2e sets the due date before enabling Repeats; the missing-anchor branch is not exercised by an e2e)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F108 · Editor blocks save on a non-positive-integer interval — 🟢 impl

*As the owner, I want be prevented from saving a repeat whose 'Every' value is empty, zero, negative, or fractional, so that an invalid cadence never reaches Core.*

**Expected behavior.** intervalInvalid = draft.recurs && (!Number.isInteger(Number(recurInterval)) || Number(recurInterval) < 1) (TodoEditor.tsx:101). When invalid, canSave is false (line 136), submit() early-returns (line 107), and an inline hint renders: 'Enter a whole number of 1 or more to save this repeat.' (lines 229-233). The interval is free text on a number input (min=1), so empty/0/fractional/negative are all caught. buildRecurrence later coerces with Number(recurInterval) (entityCodec.ts:439).

**Key files:** `apps/web/src/components/library/TodoEditor.tsx:99`, `apps/web/src/components/library/TodoEditor.tsx:229`, `apps/web/src/lib/entityCodec.ts:439`

**Existing coverage:** none found

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F109 · Edit or clear an existing Todo's recurrence rule — 🟢 impl

*As the owner, I want change a repeat's interval/unit/anchor, or turn Repeats off entirely, on an existing Todo, so that a routine can be re-cadenced or stopped without recreating the Todo.*

**Expected behavior.** todoDraftFromVm (entityCodec.ts:398) hydrates the draft from the stored rule (recurs=rule!=null, recurInterval=String(rule.interval), recurUnit, recurAnchor). buildUpdateParams diffs recurrence as a WHOLE object (entityCodec.ts:513-518): prevRule vs nextRule via JSON.stringify; when changed it sets partial.recurrence = nextRule (the new rule object) or null when toggled off. Core treats null as the sentinel-clear (apply.rs:324 merged.remove(key); ADR-0033). No recurrence key is sent when unchanged. Edge: the unsurfaced end condition round-trips — stashRecurExtra (entityCodec.ts:387) captures rule.end into recurExtra and buildRecurrence re-attaches it (line 443) so a common-path edit doesn't drop a stored until/after_count.

**Key files:** `apps/web/src/lib/entityCodec.ts:398`, `apps/web/src/lib/entityCodec.ts:513`, `apps/web/src/lib/entityCodec.ts:387`, `crates/core/src/db/apply.rs:319`

**Existing coverage:** none found (no e2e exercises editing/clearing an existing rule)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F110 · See a recurring Todo's cadence on its detail panel — 🟢 impl

*As the owner, I want read a human-readable summary of a Todo's repeat rule, so that I can tell at a glance how often it recurs.*

**Expected behavior.** EntityDetail.tsx (line 874) renders a secondary Badge with recurrenceSummary(todo.recurrence) when todo.recurrence is present. recurrenceSummary (libraryItems.ts:612) returns 'Repeats {cadence}': for interval===1 it uses the adverb form (minutely/hourly/daily/weekly/monthly/yearly via RECURRENCE_ADVERB) else 'every {interval} {unit}s' (e.g. 'Repeats every 2 weeks'). The end condition round-trips but is NOT spelled out in the summary (line 609 comment). asRecurrence (entityCodec.ts:192) defensively parses the stored snake_case rule into the camelCase VM, returning undefined unless interval is a number, unit is a known unit, and anchor ∈ {defer_at, due_at}, so a malformed stored rule shows no badge rather than throwing.

**Key files:** `apps/web/src/components/library/EntityDetail.tsx:874`, `apps/web/src/lib/libraryItems.ts:612`, `apps/web/src/lib/entityCodec.ts:192`

**Existing coverage:** tests/e2e/src/todo-recurrence.spec.ts asserts the detail shows 'repeats every 2 weeks'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F111 · Core validates the recurrence rule structure — 🟢 impl

*As the owner, I want Core to reject malformed recurrence rules at write time, so that only well-formed repeats ever persist (from both the user CRUD and agent paths).*

**Expected behavior.** validate_recurrence (entities.rs:627) rejects: a non-object rule; any unknown top-level field besides interval/unit/anchor/end ('unsupported recurrence field'); interval missing/non-integer/<1 ('recurrence interval must be a positive integer'); unit missing/non-string/not one of the six units; anchor missing/non-string/not in {defer_at, due_at}. validate_recurrence_end (entities.rs:681) rejects: a non-object end; unknown end fields; an EMPTY end object ('recurrence end must carry until or after_count'); BOTH until and after_count present ('at most one'); an empty/non-parseable until (must be YYYY-MM-DDTHH:MM:SS); after_count non-integer or <1. This single runtime authority is hit by both user entity/mutate CRUD and the agent decide path; the schemars/PayloadSpec (mutation.rs:330 recurrence_spec) only describes the tool schema, the hook validates the opaque payload.

**Key files:** `crates/core/src/entities.rs:627`, `crates/core/src/entities.rs:681`, `crates/core/src/mutation.rs:330`, `docs/adr/0037-todo-recurrence-rule.md:70`

**Existing coverage:** crates/core/src/tools/propose_workspace_mutation.rs:539 (create_todo_with_full_recurrence_validates_against_its_kind); proposal-recurring-todo.spec.ts (valid rule survives decide path)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F112 · Core enforces that the anchor's date is present on the whole Todo — 🟢 impl

*As the owner, I want Core to reject a rule whose anchor names a date the Todo lacks, so that a repeat can never reference a date that doesn't exist.*

**Expected behavior.** todo_recurrence_invariant (entities.rs:810) runs as part of validate_todo_data: it validates the rule in isolation, then checks obj[anchor] is a present, non-empty string; otherwise errors 'recurrence anchor "{anchor}" requires the todo to have {anchor}'. This cross-field check is deliberately NOT in the isolated validator (entities.rs:623 doc) — it needs the whole Todo. It is enforced on create and on the apply-time re-validation of the MERGED update_todo (apply.rs:332). On a partial update (validate_partial_todo_data, entities.rs:857), the rule is validated in isolation only and the anchor-presence cross-check is deferred to the merged-whole re-validation.

**Key files:** `crates/core/src/entities.rs:810`, `crates/core/src/entities.rs:857`, `crates/core/src/db/apply.rs:332`

**Existing coverage:** none found at e2e level (covered implicitly by the editor anchor gate; Rust unit tests likely in entities.rs but not the recurrence module)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F113 · Completing a recurring Todo spawns its next occurrence atomically — 🟢 impl

*As the owner, I want marking a recurring Todo Completed to automatically create the next occurrence, so that the routine keeps going without my re-creating it.*

**Expected behavior.** apply_update_todo (apply.rs:380) fires spawn_recurrence_successor IFF the pre-merge status was not 'completed' AND the merged status IS 'completed' AND merged carries recurrence — the active→completed transition, exactly once (a re-save of an already-completed Todo never re-spawns, per the prior_status guard at apply.rs:313). spawn_recurrence_successor (apply.rs:398) runs in the SAME transaction as the completion: it computes next via crate::recurrence::next_occurrence, builds a fresh Todo (new Uuid::now_v7 id, status reset to 'active', completed_at/dropped_at dropped, advanced defer_at/due_at, decremented rule), validates it (apply.rs:437), inserts the entity row + seq-1 revision. Both the completed original and successor land or neither does (atomic). Edge: status→dropped ends the series and spawns nothing (only the completed transition is gated); a dropped→completed edit does NOT resurrect a dropped series only because dropping it earlier already created no successor (apply.rs:374-379 comment).

**Key files:** `crates/core/src/db/apply.rs:310`, `crates/core/src/db/apply.rs:380`, `crates/core/src/db/apply.rs:398`, `docs/adr/0039-recurring-todo-occurrence-generation.md:18`

**Existing coverage:** tests/e2e/src/todo-recurrence-generation.spec.ts (completing a recurring Todo spawns its next occurrence); apply.rs has Rust tests starting at line 1506

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F114 · The successor's anchor date advances by interval x unit (naive civil math) — 🟢 impl

*As the owner, I want the next occurrence's date to be the old anchor plus interval units, with calendar-correct month/year handling, so that repeats land on the right date every cycle.*

**Expected behavior.** next_occurrence (recurrence.rs:41) and advance (recurrence.rs:121) compute next = old + interval x unit as naive wall-clock civil arithmetic on the parsed YYYY-MM-DDTHH:MM:SS tuple — no timezone/DST, no clock read (pure function of (rule, dates)). minute/hour/day/week add a fixed span of seconds (60/3600/86400/7*86400), rolling across midnight and month boundaries (e.g. 23:30 + 2h → next day 01:30). month/year shift the civil month (year = interval*12 months) and CLAMP day to the target month's last valid day via days_in_month: Jan 31 +1mo → Feb 28 (or Feb 29 leap), Mar 31 +1mo → Apr 30, Feb 29 +1yr → Feb 28; time-of-day preserved. The clamp does not 'stick' (Mar 31 +2mo → May 31). Edge: interval<1 returns None; an interval large enough to overflow i64 (checked_mul/add) returns None; a successor year past 0..=9999 returns None (format_bounded, recurrence.rs:183) — each is a safe no-successor, not a panic, since an unparseable successor would roll back the whole completion tx.

**Key files:** `crates/core/src/recurrence.rs:41`, `crates/core/src/recurrence.rs:121`, `crates/core/src/recurrence.rs:183`, `docs/adr/0039-recurring-todo-occurrence-generation.md:36`

**Existing coverage:** crates/core/src/recurrence.rs tests (advances_each_unit, clamps_month_overflow_to_month_end, clamps_leap_day_on_year_advance, advances_month_across_year_boundary, runaway_interval_yields_no_successor_not_a_panic, year_past_four_digits_yields_no_successor)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F115 · Defer and due dates both advance, preserving their gap — 🟢 impl

*As the owner, I want when a Todo has both a defer and a due date, both to advance by the same rule on the successor, so that a 'defer N days before due' relationship is kept every occurrence.*

**Expected behavior.** next_occurrence advances every PRESENT date (recurrence.rs:69-76): next_defer and next_due each computed via advance(). For minute/hour/day/week this adds an identical fixed span so the defer→due gap is preserved exactly (test both_dates_advance_in_lockstep: 6-day gap survives a weekly advance). For month/year each date keeps its OWN day-of-month, clamped independently (test month_advance_keeps_each_date_day_of_month: defer-on-15th stays 15th, due-on-31st clamps to Feb-28 independently). A date absent on the completed Todo stays absent on the successor (set_or_remove, apply.rs:430-431; Occurrence mirrors presence). The anchor names which date the until bound is measured against, not which dates advance.

**Key files:** `crates/core/src/recurrence.rs:69`, `crates/core/src/recurrence.rs:104`, `crates/core/src/db/apply.rs:430`, `docs/adr/0039-recurring-todo-occurrence-generation.md:60`

**Existing coverage:** crates/core/src/recurrence.rs tests (both_dates_advance_in_lockstep, month_advance_keeps_each_date_day_of_month, defer_anchor_advances_defer_date)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F116 · A repeat stops at its 'until' end bound — 🟢 impl

*As the owner, I want a recurring Todo with an 'until' date to stop generating successors after that instant, so that a finite repeat ends on schedule.*

**Expected behavior.** next_occurrence (recurrence.rs:81-90) measures until against the next ANCHOR date (next_defer if anchor=defer_at, next_due if anchor=due_at). The bound is INCLUSIVE: a successor whose next_anchor equals until is still generated; one strictly after (next_anchor > until via chronological string compare) ends the series → None → no successor. Edge: when anchor=defer_at the bound is checked against the advanced DEFER date even if the due date would be past a naive due check (test until_is_measured_against_the_defer_anchor). The end condition validates as a parseable wall-clock string (entities.rs:702-710).

**Key files:** `crates/core/src/recurrence.rs:78`, `crates/core/src/recurrence.rs:86`, `docs/adr/0039-recurring-todo-occurrence-generation.md:71`

**Existing coverage:** crates/core/src/recurrence.rs tests (until_inclusive_bound, until_is_measured_against_the_defer_anchor)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F117 · A repeat stops after a fixed number of occurrences (after_count) — 🟢 impl

*As the owner, I want a recurring Todo limited to N occurrences to stop after the Nth, so that a bounded repeat (e.g. 'every week for 10 weeks') ends correctly.*

**Expected behavior.** after_count counts DOWN, decremented in place on each successor (recurrence.rs:92-102): a rule with after_count:N spawns a successor carrying after_count:N-1. Completing a Todo whose CURRENT after_count <= 1 spawns nothing (recurrence.rs:59-63) — the completed Todo was the last occurrence. The <=1 gate (not ==1) defensively avoids underflow on a validation-bypassing 0 (test defensive_after_count_zero_ends_series). after_count must be an integer >=1 at every step (entities.rs:712-722) so it stays within the validated shape; no counter column. Test after_count_counts_down_to_the_last: 3→successor carries 2; 1→no successor.

**Key files:** `crates/core/src/recurrence.rs:54`, `crates/core/src/recurrence.rs:92`, `crates/core/src/entities.rs:712`, `docs/adr/0039-recurring-todo-occurrence-generation.md:75`

**Existing coverage:** crates/core/src/recurrence.rs tests (after_count_counts_down_to_the_last, defensive_after_count_zero_ends_series); proposal-recurring-todo.spec.ts persists end.after_count:10

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F118 · The successor carries title/note/project, rule, and all person refs forward — 🟢 impl

*As the owner, I want the new occurrence to inherit the completed Todo's title, note, project, recurrence rule, and people, so that each occurrence is a faithful copy of the repeating template.*

**Expected behavior.** spawn_recurrence_successor (apply.rs:419-461) builds the successor from the completed Todo's merged data: title/note/project_id/recurrence carry forward verbatim (the rule with after_count decremented); status resets to 'active' and completed_at/dropped_at are removed (apply.rs:426-428). Every todo_person_refs row on the original (both waiting_on and related) is copied to the successor with role preserved (apply.rs:455-461, person_refs_by_todo → insert_todo_person_ref). The successor inherits the completing mutation's created_by and created_via_proposal_id (apply.rs:447-452): a 'proposal' completion yields a 'proposal' successor, a 'user' completion a 'user' one. NO entity_sources row is written for the successor (ADR-0039, mirrors mark_project_reviewed). The user can edit the successor if a ref no longer applies.

**Key files:** `crates/core/src/db/apply.rs:419`, `crates/core/src/db/apply.rs:455`, `docs/adr/0039-recurring-todo-occurrence-generation.md:83`

**Existing coverage:** tests/e2e/src/todo-recurrence-generation.spec.ts asserts successor carries project_id + rule and resets status/completed_at; apply.rs Rust tests (line 1506 onward) cover refs/authorship/after_count

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F119 · A finished or non-recurring completion spawns no successor — 🟢 impl

*As the owner, I want completing a Todo whose series has ended (or that never repeated, or that was dropped) to create no new occurrence, so that finished routines stop cleanly and dropping a repeat halts it.*

**Expected behavior.** spawn_recurrence_successor returns Ok(()) doing nothing when next_occurrence returns None (apply.rs:413-417): the series ended because until was exceeded or after_count reached 1, OR the rule is malformed/runaway/year-out-of-range (fail-safe). The completed Todo stays completed; no successor row. A non-recurring Todo never enters the spawn branch (the merged.get('recurrence').is_some() guard, apply.rs:382). status→dropped ends the series and spawns nothing because only the active→completed transition is gated (apply.rs:380; ADR-0039 'dropping a repeat stops it, OmniFocus parity').

**Key files:** `crates/core/src/db/apply.rs:380`, `crates/core/src/db/apply.rs:413`, `crates/core/src/recurrence.rs:32`, `docs/adr/0039-recurring-todo-occurrence-generation.md:33`

**Existing coverage:** crates/core/src/recurrence.rs end-condition tests; apply.rs Rust tests cover the dropped/ended branches (line 1506 onward)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F120 · The agent proposes a recurring Todo that applies on accept — 🟢 impl

*As the owner, I want the assistant to propose a create_todo carrying a recurrence rule, which I can accept from the proposal card, so that I can capture a routine described in chat as a repeating Todo.*

**Expected behavior.** The propose_workspace_mutation tool surface accepts a recurrence rule on TodoData (schema single-sourced from MutationKind::payload_spec / recurrence_spec, mutation.rs:330). On accept ('Add todo' button in the proposal card), the decide/apply path validates the full rule via the validate_recurrence hook (cross-field) and persists data.recurrence to tier 2 intact, including the nested end.after_count. Edge/limit: renderCreateTodoBody (ProposalCard.tsx:2189) surfaces only Title/Note/Status/Project/People in the card — the recurrence rule (and due_at/defer_at) ride along UNSURFACED in the opaque todo{} payload and are NOT shown or editable in the card; they persist verbatim on accept (consistent with proposalEdit.ts: every unsurfaced proposed key is preserved).

**Key files:** `crates/core/src/mutation.rs:330`, `apps/web/src/components/ProposalCard.tsx:2189`, `apps/web/src/lib/proposalEdit.ts:10`, `tests/e2e/fixtures/recurring-todo-proposal.json`

**Existing coverage:** tests/e2e/src/proposal-recurring-todo.spec.ts (agent-proposed recurring Todo applies and rule persists, incl. end.after_count:10); propose_workspace_mutation.rs:539 unit test

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F121 · The end condition (until / after_count) is persisted by Core but not editable in the UI — 🟡 partial

*As the owner, I want a stored end condition to round-trip untouched through edits even though the editor has no field for it, so that editing a repeat's interval/unit/anchor never silently drops its end bound.*

**Expected behavior.** The TodoEditor exposes only the common path — interval, unit, anchor (ADR-0037 UI scope, lines 116-125); there is NO 'until' or 'after_count' control. Core validates and persists end (entities.rs:681). To avoid losing it on a common-path edit (recurrence diffs as a whole object), stashRecurExtra (entityCodec.ts:387) captures rule.end into draft.recurExtra and buildRecurrence re-attaches it (entityCodec.ts:443) so it survives byte-for-byte. asRecurrence (entityCodec.ts:208-214) parses end.until/end.after_count into the VM but recurrenceSummary deliberately does not spell it out. Limitation: an end condition can only be created via the agent/proposal or direct API path, not the rail editor.

**Key files:** `apps/web/src/lib/entityCodec.ts:387`, `apps/web/src/lib/entityCodec.ts:443`, `apps/web/src/lib/entityCodec.ts:208`, `docs/adr/0037-todo-recurrence-rule.md:116`

**Existing coverage:** none found (round-trip-of-end-through-edit is not covered by an e2e; proposal spec only verifies initial persist)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

### Search & Command Palette

#### F122 · Open and close the command palette via keyboard or sidebar — 🟢 impl

*As the owner, I want to open a global search palette with Cmd+K / Ctrl+K from anywhere (and from the sidebar Search button), and dismiss it, so that I can quickly search and navigate my workspace without leaving the current screen.*

**Expected behavior.** A global keydown listener in CommandPalette.tsx (lines 61-70) fires `toggleCommand()` whenever (metaKey || ctrlKey) and key 'k' (case-insensitive) is pressed, calling e.preventDefault() to suppress the browser default. The Sidebar Search button (Sidebar.tsx:42) calls `openCommand`. Open state lives in a zustand vanilla store (store/command.ts) exposing openCommand/closeCommand/toggleCommand/useCommandOpen; the palette is rendered as a base-ui Dialog whose onOpenChange calls closeCommand() when dismissed (Escape, backdrop click). The palette is mounted once in `__root`. On each open, transient state resets: query cleared, active index set to 0, and the input focused after a 0ms timeout (lines 127-134). E2E (command-palette.spec.ts lines 55-75) confirms both the keyboard path and the sidebar button path open the same dialog and focus the input.

**Key files:** `apps/web/src/components/CommandPalette.tsx:49-70`, `apps/web/src/components/CommandPalette.tsx:127-134`, `apps/web/src/store/command.ts:9-30`, `apps/web/src/components/Sidebar.tsx:42`, `tests/e2e/src/command-palette.spec.ts:55-75`

**Existing coverage:** command-palette.spec.ts: 'opens via the ⌘K shortcut and via the sidebar Search button'; CommandPalette.test.tsx (unit)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F123 · Filter recent threads by title in the palette — 🟢 impl

*As the owner, I want to type a query and see recent Threads whose titles match, grouped under a Threads heading, so that I can jump to a conversation by its title.*

**Expected behavior.** While the palette is open, useThreads({enabled: open}) lazily fetches the thread list (shares the sidebar cache; errors fall back to empty). The threadItems memo (CommandPalette.tsx lines 84-88) filters threads case-insensitively by `t.title.toLowerCase().includes(q)` against the trimmed lowercased immediate query `q`; when `q` is empty it shows all threads. Results are capped at 5 via `.slice(0,5)` and mapped to `{type:'thread'}` Results rendered under the 'Threads' group with a MessageSquareText glyph and the thread title. E2E (command-palette.spec.ts lines 86-90) confirms 'Zephyr' returns exactly the matching Thread and filters the other out.

**Key files:** `apps/web/src/components/CommandPalette.tsx:73`, `apps/web/src/components/CommandPalette.tsx:84-88`, `apps/web/src/components/CommandPalette.tsx:110-122`, `tests/e2e/src/command-palette.spec.ts:77-99`

**Existing coverage:** command-palette.spec.ts: 'filters live Threads and Library entities into grouped results'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F124 · Filter Library entities (people, projects, todos) by title/subtitle in the palette — 🟢 impl

*As the owner, I want to type a query and see matching Library items grouped by kind, or recently captured items when the query is empty, so that I can find a person, project, or todo and open its Library detail rail.*

**Expected behavior.** When the trimmed query `q` is non-empty, searchLibraryItems(all, query) (libraryItems.ts lines 662-683) scores each item: title.startsWith(q)=100, word-boundary regex match in title=80, title.includes(q)=60, subtitle.includes(q)=30; only score>0 items are kept, sorted by score then by item.recency descending. When `q` is empty it returns recentlyCapturedItems(all, 8). Matches are split into per-kind groups in KIND_ORDER, each labelled by KIND_META[kind].plural, rendered with EntityGlyph + libraryItemTitle/libraryItemSubtitle (CommandPalette.tsx lines 113-119, 290-301). Clicking/activating a library item navigates to /library/$kind with search {id} (lines 162-167). E2E (command-palette.spec.ts) confirms 'Quenby' resolves a Person and 'Foxglove' resolves a Project, and clicking a Library result opens its detail rail at /library/people?id=<id>.

**Key files:** `apps/web/src/components/CommandPalette.tsx:90-92`, `apps/web/src/components/CommandPalette.tsx:113-119`, `apps/web/src/lib/libraryItems.ts:662-687`, `tests/e2e/src/command-palette.spec.ts:92-98`, `tests/e2e/src/command-palette.spec.ts:135-154`

**Existing coverage:** command-palette.spec.ts: 'filters live Threads and Library entities into grouped results' and 'clicking a Library result opens its detail rail in the Library'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F125 · Find conversations by message body text in the palette (Messages group) — 🟢 impl

*As the owner, I want to type a substring of something I or the assistant wrote and see matching messages, even when the thread title does not contain the term, so that I can find a conversation by its content rather than only by its auto-generated title.*

**Expected behavior.** The palette debounces keystrokes by 180ms (useDebounced) and calls useMessageSearch(debouncedQuery) (CommandPalette.tsx lines 77-78), which issues the `message/search` RPC keyed ['message-search', trimmed], enabled only for a non-empty trimmed query (useMessageSearch.ts lines 7-21) so an empty palette makes no server call. The Messages group is gated on the DEBOUNCED query (dq), not the immediate `q` (lines 99-108), deliberately so hits stay consistent with the query they were fetched for and no stale row from the previous query is shown during the debounce window. Each hit renders the SQL-rendered snippet (bold/primary line) and thread_title (muted subtitle) with a MessageSquareText glyph (lines 273-289). E2E (message-search.spec.ts) drives a real Run so the body is indexed, then searches an interior fragment 'ylophant' of a coined token that sits past the 80-char title cutoff: exactly one Messages hit appears carrying both the snippet span ('especially the zylophant daycare schedule') and the title span, and the Threads group has zero matches — proving the body-text match path.

**Key files:** `apps/web/src/components/CommandPalette.tsx:39-47`, `apps/web/src/components/CommandPalette.tsx:77-108`, `apps/web/src/lib/hooks/useMessageSearch.ts:7-21`, `tests/e2e/src/message-search.spec.ts:31-83`

**Existing coverage:** message-search.spec.ts: '⌘K finds a message by a body substring and navigates to its thread'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F126 · Navigate and activate results with the keyboard — 🟢 impl

*As the owner, I want to move the highlighted result up/down with arrow keys and activate it with Enter, so that I can drive the palette entirely from the keyboard.*

**Expected behavior.** onKeyDown (CommandPalette.tsx lines 170-181) handles ArrowDown (active = min(i+1, max(flat.length-1, 0))), ArrowUp (active = max(i-1, 0)), and Enter (activate(flat[active])), each calling preventDefault. Results across all groups are flattened (flat = groups.flatMap items) so navigation crosses group boundaries. The active option scrolls into view via scrollIntoView({block:'nearest'}) on active change (lines 136-141), gets bg-accent styling and a CornerDownLeft enter-hint icon, and the input exposes ARIA combobox state (role=combobox, aria-activedescendant pointing at the active option id) (lines 207-213, 250-253). Hovering an option (onMouseMove) also sets it active (line 254). Typing resets active to 0 (lines 203-206). E2E (command-palette.spec.ts lines 111-133) confirms the first result is auto-selected (aria-selected=true) and pressing Enter on a Thread focuses it.

**Key files:** `apps/web/src/components/CommandPalette.tsx:124`, `apps/web/src/components/CommandPalette.tsx:136-181`, `apps/web/src/components/CommandPalette.tsx:250-254`, `tests/e2e/src/command-palette.spec.ts:111-133`

**Existing coverage:** command-palette.spec.ts: 'keyboard Enter on a Thread result focuses it back on the chat surface'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F127 · See an empty-state prompt and a no-match message instead of a blank palette — 🟢 impl

*As the owner, I want the palette to tell me to start typing when empty, and to say there are no matches when my query finds nothing, so that I am never left staring at a blank box wondering if it is broken.*

**Expected behavior.** When flat.length === 0 (CommandPalette.tsx lines 224-229), the list renders a centered paragraph: if the trimmed query is non-empty it shows `No matches for "<query>".`, otherwise it shows 'Type to search your workspace.' Groups with zero items are filtered out so no empty headers render (line 121). E2E (command-palette.spec.ts lines 101-109) confirms 'zzzznomatch' yields zero options and shows the 'No matches for' text rather than going blank.

**Key files:** `apps/web/src/components/CommandPalette.tsx:121`, `apps/web/src/components/CommandPalette.tsx:224-229`, `tests/e2e/src/command-palette.spec.ts:101-109`

**Existing coverage:** command-palette.spec.ts: 'teaches a no-match instead of going blank'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F128 · Activate a Thread result to navigate to that conversation — 🟢 impl

*As the owner, I want clicking or Entering a Thread result to close the palette and open that thread, so that I land on the conversation I picked.*

**Expected behavior.** activate() for a {type:'thread'} Result (CommandPalette.tsx lines 143-148) calls closeCommand() then navigate({to:'/thread/$threadId', params:{threadId: result.id}}). E2E (command-palette.spec.ts lines 126-133) confirms Enter on the Zephyr thread closes the palette and the thread becomes the focused sidebar row (aria-current=true).

**Key files:** `apps/web/src/components/CommandPalette.tsx:143-148`, `tests/e2e/src/command-palette.spec.ts:111-133`

**Existing coverage:** command-palette.spec.ts: 'keyboard Enter on a Thread result focuses it back on the chat surface'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F129 · Activate a message hit to deep-link, scroll to, and highlight the exact message — 🟢 impl

*As the owner, I want clicking a Messages hit to open the source thread, scroll the matched message into view, and briefly highlight it, so that I land precisely on the message I searched for, not just somewhere in the thread.*

**Expected behavior.** activate() for a {type:'message'} Result (CommandPalette.tsx lines 150-161) navigates to /thread/$threadId with params {threadId: thread_id} and search {focusedMessageId: message_id}. The route validates focusedMessageId as an optional string (thread.$threadId.tsx lines 13-18). ChatColumn (lines 127-171) runs an effect when the anchored message is actually present in the rendered list: it queries `[data-message-id="<CSS.escape(id)>"]` (URL-supplied id is escaped as defense-in-depth), and if found, scrolls it into view via scrollIntoView({block:'center', behavior:'auto'}) (motion-reduce safe), sets highlightId, claims the initial-scroll ref, and strips the anchor (consume-then-strip, replace:true). A one-shot guard (scrolledAnchorId ref) prevents re-scrolling on later re-renders while the async strip is in flight. The highlight (lamplight ring) renders via data-highlighted on the .search-jump-target row and self-clears after a 1600ms timer (lines 177-181; CSS index.css lines 242-260). The anchor jump takes precedence over the cold-load bottom-scroll (lines 110-117). E2E (scroll-to-message.spec.ts) builds an overflowing transcript, reloads to get server ids, navigates away, then activates a hit and confirms the matched message is in-viewport, wears [data-highlighted], and the URL search param is stripped to ''.

**Key files:** `apps/web/src/components/CommandPalette.tsx:150-161`, `apps/web/src/routes/_chat/thread.$threadId.tsx:13-18`, `apps/web/src/components/ChatColumn.tsx:119-181`, `apps/web/src/index.css:242-260`, `tests/e2e/src/scroll-to-message.spec.ts:52-102`

**Existing coverage:** scroll-to-message.spec.ts: '⌘K message hit deep-links to the exact message, highlights it, then strips the anchor'; ChatColumn.test.tsx: 'scrolls to and highlights the message matching the search-jump anchor'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F130 · A stale or unknown focusedMessageId strips itself without wedging the thread — 🟢 impl

*As the owner, I want a shared/typo'd or deleted deep-link whose message id is not in the thread to still show the thread and clean up the URL, so that a bad anchor never leaves the thread stuck at the top with a useless param forever.*

**Expected behavior.** In ChatColumn's anchor effect (lines 147-160), when the target is not found it distinguishes two cases: (a) history still arriving (hydrating) — wait for re-fire; (b) hydration SETTLED (hydration === 'ready' || 'not_found' || messages.length > 0) and the id genuinely isn't present — call stripAnchor() (navigate replace with empty search) so the dead anchor can't linger or wedge the cold-load bottom-scroll. E2E (scroll-to-message.spec.ts lines 104-126) opens an existing thread with a bogus focusedMessageId (00000000-...-bad): the thread still renders its real message, the URL search strips to '', and the pathname stays on the thread route.

**Key files:** `apps/web/src/components/ChatColumn.tsx:147-160`, `tests/e2e/src/scroll-to-message.spec.ts:104-126`

**Existing coverage:** scroll-to-message.spec.ts: 'a stale ?focusedMessageId (no such message) strips itself and still shows the thread'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F131 · Message search returns case-insensitive substring matches over completed messages, newest-first — 🟢 impl

*As the owner, I want the `message/search` request to match interior substrings (not just word prefixes) over both my and the assistant's completed message text, ordered newest-first, so that I can find a conversation by any fragment of what was said, with recent matches surfaced first.*

**Expected behavior.** The `message/search` JSON-RPC arm (runs/mod.rs:74) calls message::handle_search (runs/message.rs lines 17-41), which decodes MessageSearchParams {query: String} (non-string query → invalid_params at decode), runs db::search_messages, and frames MessageSearchResult {hits} newest-first; a DB fault maps to HandlerError::Internal (-32603). The SQL (queries.rs lines 2127-2177) runs `WHERE f.text LIKE '%' || ?1 || '%'` over the trigram-indexed message_fts.text, ordered `created_at DESC, m_rowid DESC`. Matching is case-insensitive (instr(lower(...), lower(...)) for the snippet). Per ADR-0035, only `completed` messages are indexed (both user and assistant roles): user text indexed at run creation, assistant text indexed at RunStatus::complete after mark_assistant_messages_completed; streaming or errored assistant text is never searchable. Rust tests confirm 'care' matches 'daycare' (interior substring), both-matching queries come back newest-first (created_at 3000 before lower), and a completed assistant message is found with role 'assistant' while a streaming/errored one is not.

**Key files:** `crates/core/src/runs/mod.rs:74-76`, `crates/core/src/runs/message.rs:17-41`, `crates/core/src/db/queries.rs:2127-2177`, `crates/core/src/db/message_fts.rs:30-67`, `docs/adr/0035-message-full-text-search.md:17-56`

**Existing coverage:** message_fts.rs tests: search_finds_user_message_by_substring_newest_first, search_finds_assistant_message_after_completion, incomplete_assistant_text_is_not_searchable; message.rs handler test (line 117); message-search.spec.ts e2e

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F132 · Message search treats LIKE wildcards as literal text and rejects blank queries — 🟢 impl

*As the owner, I want characters like % and _ in my query to match literally, and a blank/whitespace query to return nothing, so that my search never silently returns the entire corpus or behaves like an SQL wildcard.*

**Expected behavior.** search_messages (queries.rs lines 2127-2177) first guards `if query.trim().is_empty() { return Ok(vec![]) }` so a blank or whitespace-only needle returns no hits rather than matching everything via LIKE '%%' (also independently guarded; message_fts.rs handles the boundary regardless of caller). For needles containing %, _, or \ (needs_like_escape), it takes an ESCAPE '\' path binding escape_like(query) so the wildcards match literally; otherwise it takes the plain LIKE path which preserves trigram acceleration (a documented trade-off: SQLite disables trigram LIKE acceleration when ESCAPE is present). Rust tests confirm '%' matches only the literal-percent message (not all three), '_' matches only the literal-underscore message, and all blanks ['', '   ', '\t\n'] return zero hits while a real needle still matches.

**Key files:** `crates/core/src/db/queries.rs:2116-2177`, `crates/core/src/db/message_fts.rs:237-293`, `docs/adr/0035-message-full-text-search.md:37-56`

**Existing coverage:** message_fts.rs tests: search_treats_like_wildcards_as_literal, search_blank_query_returns_no_hits

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F133 · Message search returns a context snippet around the first match, byte-safe over Unicode — 🟢 impl

*As the owner, I want each hit to carry a readable snippet excerpting the text around my matched term, with ellipses where trimmed, so that I can recognize the right message from the result row without opening the thread.*

**Expected behavior.** The snippet is rendered in SQL (queries.rs lines 2140-2155) using instr/substr around the first case-insensitive match, keeping SNIPPET_PAD chars of context per side and prepending/appending '…' when the snippet is trimmed at the start/end (`CASE WHEN s.start > 1 THEN '…'` / `CASE WHEN ... < length(s.text) THEN '…'`). SQLite substr is char-based so there is no byte-slice hazard. ADR-0035 notes the FTS5 snippet() helper is NOT used (it requires MATCH); recency ordering is used instead of relevance because trigram carries no bm25 ranking. Rust test search_snippet_survives_multibyte_text confirms a match surrounded by İ (U+0130, folds to two chars), emoji, and accents returns a correct non-empty snippet containing 'needle' and never panics. E2E asserts the rendered snippet window contains 'especially the zylophant daycare schedule' (±32 chars of context).

**Key files:** `crates/core/src/db/queries.rs:2110-2158`, `crates/core/src/db/message_fts.rs:215-235`, `docs/adr/0035-message-full-text-search.md:51-56`, `tests/e2e/src/message-search.spec.ts:58-70`

**Existing coverage:** message_fts.rs tests: search_snippet_survives_multibyte_text; message-search.spec.ts snippet assertions

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F134 · Message search index self-heals and backfills on every workspace open — 🟢 impl

*As the owner, I want the search index to be rebuilt from the canonical message parts on each open, so that existing conversations become searchable and any index drift self-heals without my involvement.*

**Expected behavior.** message_fts is a tier-3 derived projection (ADR-0004): authoritative for nothing, re-derivable from message_parts. rebuild_message_fts (message_fts.rs lines 74-85) opens a transaction, clears message_fts, fetches all completed messages, reassembles each message's text via the canonical text_parts_by_message().concat() (the same path history_for_run uses), and re-indexes via index_message (which skips empty text). Per ADR-0035 Core runs this on every workspace open — O(all completed messages), single-digit ms at single-user scale, off any path the user waits on. Rust test rebuild_reconstructs_index_from_message_parts confirms that after wiping message_fts (0 hits) a rebuild restores the daycare hit from message_parts.

**Key files:** `crates/core/src/db/message_fts.rs:69-85`, `crates/core/src/db/message_fts.rs:424-467`, `docs/adr/0035-message-full-text-search.md:69-87`

**Existing coverage:** message_fts.rs test: rebuild_reconstructs_index_from_message_parts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F135 · Reusable search field with leading icon, variants, and optional clear button — 🟢 impl

*As the owner, I want a consistent search input with a magnifier icon, style variants, and a clear (✕) button when there is text, so that search inputs look and behave consistently across the palette, Library, and model picker.*

**Expected behavior.** SearchField (ui/search-field.tsx) renders a leading Search icon, an Input that forwards all input props, and — only when both onClear and a value are present — a clear button (aria-label 'Clear search') showing an X icon that calls onClear (lines 67-76). It exposes three wrapper variants via cva: box (bordered card), divider (bottom border), dialog (taller h-13 base-size input for the palette), plus a tone variant ('default' / 'sidebar' which recolors the icon and placeholder). The palette uses variant='dialog' with combobox ARIA wiring (CommandPalette.tsx lines 199-215); EntityCollection uses variant='box' with onClear and an aria-label `Search <plural>` (EntityCollection.tsx lines 109-117); ModelPicker uses variant='divider' with 'Search models…' placeholder (ModelPicker.tsx lines 70-76). The palette variant intentionally omits onClear (no ✕), relying on per-open reset instead.

**Key files:** `apps/web/src/components/ui/search-field.tsx:7-79`, `apps/web/src/components/CommandPalette.tsx:199-215`, `apps/web/src/components/library/EntityCollection.tsx:109-117`, `apps/web/src/components/ModelPicker.tsx:70-76`

**Existing coverage:** Exercised indirectly via command-palette.spec.ts (input/focus) and library.spec.ts; no dedicated unit test found for search-field.tsx

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F136 · Agent capability: search accepted People/Projects/Todos via the search_entities tool — 🟢 impl

*As the assistant (agent capability), I want to look up accepted entities by type and a case-insensitive substring query and get back compact rows, so that the model can reference or link existing People, Projects, and Todos without arbitrary SQL access.*

**Expected behavior.** search_entities (tools/search_entities.rs) is a Core tool (registered in tools/mod.rs lines 99-103, Dispatch::Pool over a read-only pool) taking Input {type: EntityKind (closed person/project/todo enum), query: String, limit: Option<u32>}. Core re-validates args against the struct on receipt (ADR-0018); an unknown type like 'journal_entry' fails as invalid_params (test). It loads accepted entities only via db::list_by_type (no proposals, no CRUD), case-insensitively matching the lowercased needle against the entity label (data.name for person/project, data.title for todo) and, for persons only, any alias; an empty query matches all of that type. Results are compact rows {id, type, label, aliases?} (aliases only for persons with non-empty aliases), capped: limit defaults to DEFAULT_LIMIT=20 and is clamped to MAX_LIMIT=50, returned as a JSON `{"results": [...]}` text payload. display_arg (lines 65-73) returns the trimmed query for the tool-activity row label, or None for an empty/whitespace query or a malformed payload (no panic). The descriptor exposes name 'search_entities', label 'Search entities', and the closed type enum. Note: ADR-0035 records that entity full-text search was judged churn at single-user scale (data is already client-side), so message search got its own table while the dead `fts` entity table was left untouched.

**Key files:** `crates/core/src/tools/search_entities.rs:14-167`, `crates/core/src/tools/mod.rs:99-103`, `docs/adr/0035-message-full-text-search.md:59-66`

**Existing coverage:** search_entities.rs tests: person_search_matches_name_and_alias_excludes_others, todo_matches_title_project_matches_name_no_aliases, empty_query_returns_all_of_type_and_limit_caps, limit_defaults_to_20_and_clamps_at_50, invalid_type_is_invalid_params, display_arg_returns_trimmed_query_or_none, descriptor_has_name_label_and_type_enum

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F137 · message/search wire contract is mirrored and contract-tested across Rust and TypeScript — 🟢 impl

*As the owner, I want the message/search params, hits, and result shapes to be identical on the wire between Core and the web client, so that search results render correctly and the contract cannot silently drift.*

**Expected behavior.** protocol.rs (lines 410-439) defines MessageSearchParams {query: String} (Deserialize), MessageHit {message_id, thread_id, run_id, role, snippet, thread_title, created_at: i64} (Serialize, snake_case wire, role is 'user'/'assistant', created_at is ms-epoch), and MessageSearchResult {hits: Vec<MessageHit>} (object-wrapper for forward-extensibility). These mirror the TS types and are validated by a contract test (parses!(MessageSearchParams, "message_search_params.json") at line 2161) and serialization snapshot tests (lines 1415-1438, 1751-1755). The web client calls client.messageSearch(trimmed) via the ui-sdk WsClient (useMessageSearch.ts lines 14-18). MessageSearchParams rejects missing query and a non-string query (json!({}) and {query:42} both fail to deserialize, lines 1415-1416).

**Key files:** `crates/core/src/protocol.rs:410-439`, `crates/core/src/protocol.rs:1415-1438`, `crates/core/src/protocol.rs:2161`, `apps/web/src/lib/hooks/useMessageSearch.ts:14-18`

**Existing coverage:** protocol.rs contract/serialization tests (message_search_params.json parses!, MessageSearchResult serialize snapshots)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

### Settings, Models & Providers

#### F138 · Open the Models settings page from the chat shell — 🟢 impl

*As the owner, I want to click the Settings gear to reach the Models settings page, so that I can manage my provider, model, and reasoning effort.*

**Expected behavior.** The nav-shell renders a gear button with aria-label "Settings" (Settings2 icon) that fires onOpenSettings (nav-shell.tsx:57-66). In LibraryNav onOpenSettings navigates to /settings/models (LibraryNav.tsx:37). The /settings route (route.tsx:72-74) renders SettingsLayout: a "Back to Chat" Link to "/" (route.tsx:43-49), a single "Models" tab Link to /settings/models with active styling (route.tsx:54-62), and an <Outlet/>. Pressing Escape pushes settingsExitHref() to exit the takeover, but only while the command palette is closed (route.tsx:18-25) so a first Esc dismisses the palette. The /settings/models route mounts ModelsSettings (models.tsx:132-134) with heading "Models" and subtitle "Connect a provider, choose your preferred model, and set how hard it thinks." (models.tsx:88-92). e2e confirms the gear navigates and the "Models" heading is visible.

**Key files:** `apps/web/src/components/ui/nav-shell.tsx:57`, `apps/web/src/components/library/LibraryNav.tsx:37`, `apps/web/src/routes/settings/route.tsx:18`, `apps/web/src/routes/settings/route.tsx:72`, `apps/web/src/routes/settings/models.tsx:88`, `apps/web/src/routes/settings/models.tsx:132`

**Existing coverage:** models-settings.spec.ts (gear navigates to /settings/models, Models heading visible); connect-provider.spec.ts (same navigation)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F139 · View current preferred model and reasoning effort — 🟢 impl

*As the owner, I want to see my currently preferred model and global reasoning effort when I open settings, so that I know what new chats will use.*

**Expected behavior.** On mount ModelsSettings calls fetchSettings(runtime) -> WsClient.settingsGet() (settings.ts:9-17) and seeds effort + selectedModel state (models.tsx:38-46). Core's settings/get (settings.rs:33-45) returns SettingsResult { provider, model, effort } via current(): provider = default_workflow().provider; model = settings::preferred_model(pool, wf.name), falling back to models::default_model(provider) (settings.rs:18-31); effort = settings::effort_setting(pool) or DEFAULT_EFFORT ("off", settings.rs:23-25, settings.rs:26). The catalog also loads via fetchCatalog (models.tsx:47-52). Edge: a fetch error is swallowed with .catch(() => {}) leaving effort at its initial "off" and selectedModel null; an `alive` flag (models.tsx:39-55) prevents setState after unmount. SettingsResult.model is Option<String> serialized as null only when the provider has no default (protocol.rs:698-707).

**Key files:** `apps/web/src/routes/settings/models.tsx:38`, `apps/web/src/store/settings.ts:9`, `crates/core/src/runs/settings.rs:18`, `crates/core/src/runs/settings.rs:33`, `crates/core/src/protocol.rs:698`

**Existing coverage:** models.page.test.tsx ("reflects provider connection + global effort from the backend"); models-settings.spec.ts (GPT-5.5 shown Preferred on first load)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F140 · See the per-provider default model as Preferred before any explicit pick — 🟢 impl

*As the owner, I want a sensible default model already marked Preferred when I have never picked one, so that new chats work out of the box without me choosing.*

**Expected behavior.** settings/get's current() does settings::preferred_model(...).or_else(|| models::default_model(&wf.provider).map(str::to_string)) (settings.rs:20-22), so with no stored preference the result.model is the provider default. models::default_model returns Some("gpt-5.5") for "openai-codex" and None otherwise (models/mod.rs:40-45). "gpt-5.5" exists in the embedded catalog as "GPT-5.5" (openai-codex.json:80-81), so ModelCatalogTable marks that row Preferred (m.id === selectedId, ModelCatalogTable.tsx:58). This is the ".or_else(default_model)" fix: the same fallback is mirrored in dispatcher::resolve_effective_workflow (dispatcher.rs:52-55) so the displayed default matches what a Run actually uses. Edge: a provider without a default yields model=null and no row is Preferred until the user picks.

**Key files:** `crates/core/src/runs/settings.rs:20`, `crates/core/src/models/mod.rs:40`, `crates/core/src/models/openai-codex.json:80`, `crates/core/src/dispatcher.rs:52`, `apps/web/src/components/ModelCatalogTable.tsx:58`

**Existing coverage:** models-settings.spec.ts (asserts GPT-5.5 row shows Preferred before any pick); doc comment in spec explicitly calls out the default-as-preferred behavior

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F141 · Set a preferred model from the catalog table — 🟢 impl

*As the owner, I want to mark any catalog model as my preferred model on the settings page, so that new chats default to the model I prefer.*

**Expected behavior.** ModelCatalogTable renders one row per model (name, CostBadge, Reasoning/Vision chips). The selected row shows a primary "Preferred" badge with a Star; every other row reveals a "Set as preferred" button on hover/focus (opacity-0 -> group-hover/row:opacity-100, ModelCatalogTable.tsx:94-108). Clicking it calls onSelect(m.id) -> models.tsx onSelectModel: optimistically setSelectedModel(id), then saveSettings(runtime,{model:id}) -> WsClient.settingsSet, reconciling with the returned s.model (models.tsx:75-83, settings.ts:20-29). Core settings/set validates model with models::is_known_model BEFORE any write and rejects unknown ids with invalid_params (settings.rs:55-59); on success it persists via settings::set_preferred_model under key model:<workflow_name> (settings.rs:67-71, settings.rs:54-60) and returns the re-read SettingsResult. Edge: a save error is swallowed (.catch(() => {})) so the optimistic selection stays without server reconciliation. The button honors a `disabled` prop (ModelCatalogTable.tsx:102).

**Key files:** `apps/web/src/components/ModelCatalogTable.tsx:94`, `apps/web/src/routes/settings/models.tsx:75`, `crates/core/src/runs/settings.rs:55`, `crates/core/src/settings.rs:54`

**Existing coverage:** models-settings.spec.ts (hover GPT-5.4 Mini row, click "Set as preferred", row becomes Preferred and survives reload); models.page.test.tsx ("lists the catalog and persists a preferred model via settings/set")

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F142 · Change the global reasoning effort — 🟢 impl

*As the owner, I want to set how hard the model reasons before answering, globally, so that every chat uses my preferred reasoning depth.*

**Expected behavior.** EffortControl is a segmented radiogroup (role=radiogroup aria-label "Reasoning effort") with six radios from EFFORT_LEVELS: off, minimal, low, medium, high, xhigh, labelled Off/Minimal/Low/Medium/High/Max (EffortControl.tsx:4-22). The active level has aria-checked=true and bg-background styling (EffortControl.tsx:43-51). Clicking a level calls onChange -> models.tsx onEffortChange: optimistic setEffort(next) then saveSettings(runtime,{effort:next}) reconciling with s.effort (models.tsx:65-73). Core settings/set validates effort with workflow::is_valid_thinking_level (THINKING_LEVELS, six values) BEFORE write, rejecting bad values with invalid_params (settings.rs:60-64, workflow.rs:17-23), then persists via settings::set_effort under key "effort" (settings.rs:72-76, settings.rs:40-42). Edge: save errors swallowed; controls honor `disabled` prop (opacity-50, disabled cursor).

**Key files:** `apps/web/src/components/EffortControl.tsx:4`, `apps/web/src/routes/settings/models.tsx:65`, `crates/core/src/runs/settings.rs:60`, `crates/core/src/workflow.rs:17`, `crates/core/src/settings.rs:40`

**Existing coverage:** models-settings.spec.ts (click High radio, assert aria-checked true, persists across reload); models.page.test.tsx ("persists an effort change via settings/set"); EffortControl.test.tsx

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F143 · Have model and effort choices persist across reload and into Runs — 🟢 impl

*As the owner, I want my model and effort choices to survive a page reload and apply to new chats, so that my configuration is durable, not just client state.*

**Expected behavior.** Both choices round-trip through Core's settings/* into tier-2 SQLite (settings::set_preferred_model / set_effort write through db::set_setting, settings.rs:40-60). On reload the SPA re-reads via fetchSettings/settings/get (models.tsx:38-46). Crucially, settings/get's current() and dispatcher::resolve_effective_workflow share the same resolution order so the displayed value equals the Run value: model = user setting -> models::default_model(provider) -> TOML model; effort = user setting -> TOML thinking_level -> DEFAULT_EFFORT (dispatcher.rs:40-59). Edge (ADR-0024): a resumed Run rebuilds its Workflow from the runs snapshot and never re-resolves live settings, so a mid-Run setting change cannot leak into a running Run (dispatcher.rs:9-13). A settings read error in resolution is treated as "unset" so a transient DB hiccup falls back to default rather than failing the Run (dispatcher.rs:47-50).

**Key files:** `crates/core/src/dispatcher.rs:40`, `crates/core/src/settings.rs:40`, `apps/web/src/routes/settings/models.tsx:38`

**Existing coverage:** models-settings.spec.ts (full page reload, both Mini-as-Preferred and High effort still reflected — proves SQLite round-trip not just client state)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F144 · Reject unknown model ids and invalid effort values — 🟢 impl

*As the owner, I want bad model/effort values rejected without corrupting my stored settings, so that an invalid value never persists.*

**Expected behavior.** settings/set validates BOTH fields before any write (ADR-0002/ADR-0014): an unknown model -> HandlerError::InvalidParams("unknown model …"); an invalid effort -> InvalidParams("invalid effort …") (settings.rs:54-64). is_known_model scans every provider's catalog models for a matching id (models/mod.rs:29-34); is_valid_thinking_level checks THINKING_LEVELS (workflow.rs:21-23). Because validation precedes the writes, a request that sets one bad field persists nothing at all. SettingsSetParams is a partial update — both fields #[serde(default)] Option, an empty object {} is valid and changes nothing (protocol.rs:709-718, decode tests at protocol.rs:1398-1408). Note: the web UI only ever sends catalog ids / valid levels, so this guards SDK/protocol misuse rather than a UI path.

**Key files:** `crates/core/src/runs/settings.rs:54`, `crates/core/src/models/mod.rs:29`, `crates/core/src/workflow.rs:21`, `crates/core/src/protocol.rs:709`

**Existing coverage:** protocol.rs decode tests for SettingsSetParams (only_effort/only_model/empty); no e2e exercises the rejection path

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F145 · Browse the model catalog with cost and capability chips — 🟢 impl

*As the owner, I want to see available models with their cost tier and capabilities, so that I can choose a model knowingly.*

**Expected behavior.** model/catalog (catalog.rs:10-19) returns the embedded, read-only ModelCatalogResult from models::catalog() (parsed once via OnceLock; malformed embedded JSON panics at build/first-access as a build bug, models/mod.rs:20-24). The catalog is hand-mirrored from pi-ai's MODELS["openai-codex"] (models/mod.rs:1-7) with a Worker drift test guarding it. ModelInfo carries id, name, reasoning, input[], cost_input, cost_output (protocol.rs:671-681). ModelCatalogTable maps cost_output to a tier via CostBadge: <=0 "Free"/$0, <5 Low/$, <15 Medium/$$, else High/$$$ (ModelCatalogTable.tsx:6-29); shows a "Reasoning" chip when reasoning and a "Vision" chip when input includes "image" (ModelCatalogTable.tsx:77-88). Edge: an empty models array renders "No models available. Connect a provider to see its models." (ModelCatalogTable.tsx:45-51). models.tsx flattens providers into one model list (c.providers.flatMap(p => p.models), models.tsx:50).

**Key files:** `crates/core/src/runs/catalog.rs:10`, `crates/core/src/models/mod.rs:20`, `crates/core/src/protocol.rs:671`, `apps/web/src/components/ModelCatalogTable.tsx:6`, `apps/web/src/routes/settings/models.tsx:47`

**Existing coverage:** models-settings.spec.ts (runs against real openai-codex catalog over model/catalog); ModelCatalogTable.test.tsx; models.page.test.tsx (lists the catalog)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F146 · Pick the model from the composer model picker — 🟢 impl

*As the owner, I want to switch models from a picker in the chat composer, so that I can change models without leaving the chat.*

**Expected behavior.** ModelPicker (wired into ComposeFooter.tsx:76) is a Popover whose trigger shows selected?.name ?? "Select model" with a ChevronDown (ModelPicker.tsx:59-65). On mount it loads catalog + settings (ModelPicker.tsx:19-34). The popup has a SearchField filtering by name or id (case-insensitive, ModelPicker.tsx:41-47) and lists models with a Brain icon, a Vision (Eye) icon when input includes "image", and a Check on the selected row (ModelPicker.tsx:95-113). Picking calls pick(id): optimistic setSelectedId, close popover, saveSettings({model:id}) reconciling with s.model (ModelPicker.tsx:49-55) — the same settings/set path as the settings page, so composer and settings stay in sync. Edge: an empty/over-filtered list renders "No models available." (ModelPicker.tsx:78-81). Edge: "Select model" appears as the trigger label whenever selectedId is null or not found in the loaded catalog (selected resolved via models.find, ModelPicker.tsx:36-39) — note settings/get's default-model fallback normally prevents a null selection.

**Key files:** `apps/web/src/components/ModelPicker.tsx:36`, `apps/web/src/components/ModelPicker.tsx:49`, `apps/web/src/components/ComposeFooter.tsx:76`

**Existing coverage:** no dedicated spec found; covered indirectly by settings/set path tests

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F147 · Adjust reasoning effort from the composer effort picker — 🟢 impl

*As the owner, I want to change reasoning effort from the chat composer, so that I can tune effort per session without opening settings.*

**Expected behavior.** EffortPicker (wired into ComposeFooter.tsx:77) is a Popover; the trigger shows a Gauge icon plus the current level label (LABELS[effort] ?? "Effort") and a ChevronDown (EffortPicker.tsx:45-52). On mount it reads the global effort via fetchSettings (EffortPicker.tsx:24-34). The popup reuses EffortControl plus the copy "Higher effort thinks longer before replying. Applies to new messages." (EffortPicker.tsx:56-63). change(next) is optimistic then saveSettings({effort:next}) reconciling with s.effort (EffortPicker.tsx:36-41) — same global setting as the settings page (effort is global, not per-thread, settings.rs:17-18). Edge: an unknown stored effort falls back to the literal "Effort" label on the trigger (EffortPicker.tsx:49).

**Key files:** `apps/web/src/components/EffortPicker.tsx:36`, `apps/web/src/components/EffortPicker.tsx:45`, `apps/web/src/components/ComposeFooter.tsx:77`

**Existing coverage:** no dedicated spec found; EffortControl.test.tsx covers the inner control; settings/set path covered by models.page.test.tsx

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F148 · View the ChatGPT provider connection status — 🟢 impl

*As the owner, I want to see whether my LLM provider (ChatGPT) is connected, so that I know if my chats can authenticate.*

**Expected behavior.** ProviderConnectionCard shows the provider name ("ChatGPT"), an avatar of its first letter, and a status line with data-testid=provider-status reading "Checking…" when connected===null, "Connected" when true, "Not connected" when false (ProviderConnectionCard.tsx:23-47). When connected it shows a secondary "Connected" Badge with a Check; otherwise a "Connect" Button disabled while busy or while connected===null (ProviderConnectionCard.tsx:49-63). models.tsx refreshConnected calls fetchConnected -> WsClient.providerStatus(), finding the openai-codex entry's connected flag (default false, providers.ts:9-19). Core provider/status reports only openai-codex as the single supported provider; connected = credentials::is_connected (a parseable credential file exists, expiry NOT considered) (provider.rs:25-38, credentials.rs:79-83). Edge: a corrupt/unparseable credential file surfaces as an Internal error rather than a misleading connected:false (provider.rs:26-29, credentials.rs:64-77).

**Key files:** `apps/web/src/components/ProviderConnectionCard.tsx:23`, `apps/web/src/store/providers.ts:9`, `crates/core/src/runs/provider.rs:25`, `crates/core/src/credentials.rs:79`

**Existing coverage:** connect-provider.spec.ts (asserts provider-status reads "Not connected" initially, then "Connected"); ProviderConnectionCard.test.tsx; models.page.test.tsx (reflects provider connection)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F149 · Connect ChatGPT via OAuth — 🟢 impl

*As the owner, I want to click Connect and authorize ChatGPT in my browser, so that my chats can use my ChatGPT/Codex account.*

**Expected behavior.** Clicking Connect calls models.tsx onConnect: setBusy(true), startLogin(runtime, openai-codex) then .finally(setBusy false) (models.tsx:58-63). startLogin runs WsClient.providerLoginStart, then opens the returned authorize_url in a new tab via window.open(_blank, noopener,noreferrer) (providers.ts:29-40). Core provider/login_start (provider.rs:65-186): rejects an unknown provider with invalid_params; enforces single-flight via LOGIN_IN_FLIGHT AtomicBool (the helper binds fixed loopback :1455) returning ProviderLoginFailed "a provider login is already in progress" on overlap (provider.rs:80-87); resolves the launch command via launch::resolve(Role::ProviderLogin) (INKSTONE_PROVIDER_LOGIN_CMD override or tsx default, ADR-0041); spawns the Provider Helper, reads its stdout LoginLine JSON until AuthorizeUrl, and returns ProviderLoginStartResult { authorize_url } (provider.rs:128-183). After the URL, a spawned task drains the helper for the Credentials line and persists it via credentials::write (provider.rs:164-181). The latch is released on every failure/exit path. Edge cases: helper emits Error before URL -> ProviderLoginFailed; helper exits before URL -> ProviderLoginFailed "exited before authorize URL"; non-JSON noise is skipped (provider.rs:128-159). The Provider Helper is its own package (ADR-0040).

**Key files:** `apps/web/src/routes/settings/models.tsx:58`, `apps/web/src/store/providers.ts:29`, `crates/core/src/runs/provider.rs:65`, `crates/core/src/runs/provider.rs:80`

**Existing coverage:** connect-provider.spec.ts (Connect with stubbed login helper, window.open stubbed no-op, end-to-end happy path); no e2e for the single-flight / error LoginLine branches

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F150 · See the connection flip to Connected after returning to the tab — 🟢 impl

*As the owner, I want the provider card to update to Connected after I finish the browser OAuth flow, so that I get feedback without manually refreshing.*

**Expected behavior.** Because login completes in a separate browser tab, ModelsSettings re-queries provider/status on mount AND on window focus: a focus listener calls refreshConnected and is cleaned up on unmount (models.tsx:30-36). When the user returns to the tab, fetchConnected re-runs and the card flips to Connected once Core has persisted the credential out-of-band (provider.rs:164-181 writes the file; credentials::is_connected then returns true). This focus-driven design is per ADR-0023 ("the Client learns the outcome by re-querying provider/status on focus", provider.rs:162-163). Edge: a fetchConnected rejection sets connected=false via .catch (models.tsx:25-27).

**Key files:** `apps/web/src/routes/settings/models.tsx:30`, `crates/core/src/runs/provider.rs:162`, `crates/core/src/credentials.rs:79`

**Existing coverage:** connect-provider.spec.ts (dispatches focus events in a poll loop until provider-status reads "Connected")

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F151 · Have provider credentials refreshed and injected into Runs securely — 🟢 impl

*As the owner, I want my access token kept fresh and only the short-lived token used by chats, so that my chats stay authenticated and my refresh token never leaks.*

**Expected behavior.** provider_auth::resolve_access_token(provider, now_ms) returns None for any non-openai-codex provider and when no credential is stored (the Run proceeds tokenless and the provider call fails with an auth error, prompting connect) (provider_auth.rs:33-42). A valid token is returned as-is; an expired token (creds.is_expired, credentials.rs:38-43) triggers a single-flight refresh under a process-global async Mutex with double-checked expiry so concurrent Runs trigger exactly one refresh (provider_auth.rs:44-61). Refresh spawns the Provider Helper in refresh mode (launch::resolve Role::ProviderRefresh, INKSTONE_PROVIDER_HELPER_CMD override or tsx), feeds the refresh token on stdin, reads the rotated Credentials line, persists via credentials::write, and returns the new access token (provider_auth.rs:78-132). Credentials are stored as a 0600 JSON file in a 0700 dir beside the SQLite DB, Core the single writer (ADR-0023, credentials.rs:85-117); the Debug impl redacts access/refresh tokens (credentials.rs:27-36). Edge: helper Error line -> bail "provider helper refresh failed"; no result line -> bail "produced no result line" (provider_auth.rs:107-132).

**Key files:** `crates/core/src/provider_auth.rs:33`, `crates/core/src/provider_auth.rs:78`, `crates/core/src/credentials.rs:38`, `crates/core/src/credentials.rs:85`

**Existing coverage:** credentials.rs unit tests (write_then_read_round_trips_at_0600, debug_redacts_tokens); no e2e for the refresh path

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F152 · exit-settings-takeover-esc-and-back — ⚪ gap

**Expected behavior.** CRITIC-FOUND GAP (no story written yet): settings-providers has 'open-settings-models-page' but nothing about leaving the settings takeover. The settings shell (routes/settings/route.tsx) is a full-screen takeover with three exit/nav affordances: (1) pressing Esc pushes back to the last non-settings location tracked in store/settings-origin, but only while the command palette is closed so a first Esc dismisses the palette instead; (2) a 'Back to Chat' link; (3) a 'Settings sections' tab nav (Models). The Esc-returns-to-origin behavior in particular is a subtle, user-observable contract with no story.

**Key files:** `/Users/lyuhongy/dev/inkstone/apps/web/src/routes/settings/route.tsx, /Users/lyuhongy/dev/inkstone/apps/web/src/store/settings-origin.ts, /Users/lyuhongy/dev/inkstone/apps/web/src/routes/__root.tsx (noteNonSettingsLocation)`

**Existing coverage:** none found

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F153 · login-opens-authorize-url-in-new-tab — ⚪ gap

**Expected behavior.** CRITIC-FOUND GAP (no story written yet): 'connect-provider-oauth' covers initiating OAuth and 'connection-flips-on-focus' covers the post-return status flip, but the actual mechanic in between has no story: startLogin calls provider/login_start to fetch an authorize_url then opens it in a NEW BROWSER TAB via window.open(url, '_blank', 'noopener,noreferrer'); the credential write happens out-of-band in that tab while the main app waits. The provider-helper process (packages/provider-helper) runs the :1455 loopback and relays the authorize URL up through Core. The new-tab handoff is the load-bearing, user-visible step.

**Key files:** `/Users/lyuhongy/dev/inkstone/apps/web/src/store/providers.ts (startLogin, openUrl/window.open at lines 24-39), /Users/lyuhongy/dev/inkstone/packages/provider-helper/src/provider.ts (runLogin onAuth emits authorize_url), /Users/lyuhongy/dev/inkstone/apps/web/src/routes/settings/models.tsx`

**Existing coverage:** none found

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

### Run Control & Lifecycle

#### F154 · Cancel a running run — 🟢 impl

*As the owner, I want to stop a run that is actively streaming, so that I can abort a reply I no longer want without waiting for it to finish.*

**Expected behavior.** run/cancel reaches crate::cancel::cancel (crates/core/src/cancel.rs:52). For a Run whose status is Running it attempts the guarded running->cancelled transition via db::cancel_running_run (crates/core/src/db/mod.rs:1382 -> RunStatus::cancel_running, lifecycle.rs:268), which runs `mark_running_run_cancelled` guarded on `WHERE status='running'`. On a WON transition (Moved::Won) the verb: (a) flips runs.status to cancelled with terminal_reason='cancelled' and any still-streaming Messages to incomplete (lifecycle.rs:275-292), (b) resolves the live RunHub via the injected get_hub and calls run_hub.cancel() to flip the in-memory cancel watch (hub.rs:53), and (c) returns Outcome::Accepted{hub:Some(..)}. The handler (runs/cancel.rs:39-48) frames the Response with outcome string 'accepted' FIRST, then calls cancel::publish_cancelled (cancel.rs:100) which broadcasts RunEvent::Cancelled and hub::remove — preserving deterministic response->cancelled wire order. Edge: the broadcast RunEvent::Cancelled is the only terminal event for this Run; the worker loop's own terminal tx will LOSE its guard (worker/run.rs:243 only publishes done/error when moved.won()), so no `done` is ever emitted for a cancelled run.

**Key files:** `crates/core/src/cancel.rs:52`, `crates/core/src/cancel.rs:69`, `crates/core/src/cancel.rs:100`, `crates/core/src/runs/cancel.rs:39`, `crates/core/src/db/mod.rs:1382`, `crates/core/src/db/lifecycle.rs:268`, `crates/core/src/hub.rs:53`

**Existing coverage:** tests/e2e/src/run-cancel.spec.ts (raw WebSocket: thread/create -> subscribe -> cancel on first delta -> asserts outcome 'accepted', a 'cancelled' event, and that NO 'done' is emitted); unit tests cancel.rs running_won_signals_then_publishes_and_removes

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F155 · Cancel a run parked on a proposal — 🟢 impl

*As the owner, I want to stop a run that is parked awaiting my decision on a proposal, so that I can abandon a pending change instead of accepting or rejecting it.*

**Expected behavior.** When run/cancel targets a Run whose status is Parked, crate::cancel::cancel takes the parked branch (cancel.rs:59-68): there is no live Worker, so get_hub is never consulted (a unit test panics if it is — cancel.rs:225). It calls db::cancel_parked_run (db/mod.rs:1354), which in ONE tier-2 transaction: finds the pending Proposal for the run (rolls back to `false` if none), runs ProposalStatus::cancel guarded on status='pending' (lifecycle.rs:375), then RunStatus::cancel guarded on status='parked' (lifecycle.rs:242), each appending a 'cancelled' run_log row (target 'proposal' and target 'run' respectively) and flipping streaming Messages to incomplete. A true return -> Outcome::Accepted{hub:None}; the handler returns outcome 'accepted' and publish_cancelled is a no-op (no hub). Edge: if the pending Proposal already vanished (a concurrent decide won), the transaction rolls back and the verb returns AlreadyTerminal, leaving the Run parked (cancel.rs:339 test asserts run stays 'parked').

**Key files:** `crates/core/src/cancel.rs:59`, `crates/core/src/db/mod.rs:1354`, `crates/core/src/db/lifecycle.rs:242`, `crates/core/src/db/lifecycle.rs:375`, `crates/core/src/runs/cancel.rs:39`

**Existing coverage:** tests/e2e/src/run-cancel-parked.spec.ts (UI Stop on a parked propose-run: asserts the bubble settles to 'stopped before it finished', the pending proposal card disappears, and 'added it' never appears since no resume); tests/e2e/src/run-lifecycle-record.spec.ts second test 'Stop is available while parked and settles the parked Run'; unit tests cancel.rs parked_run_is_accepted_and_flips_run_and_proposal and parked_race_lost_is_already_terminal

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F156 · Cancelling an already-finished run is a no-op result — 🟢 impl

*As the owner, I want a cancel request on a run that already ended to be reported as already-terminal rather than as an error, so that a Stop click racing a completion does not surface a spurious failure.*

**Expected behavior.** crate::cancel::cancel returns Outcome::AlreadyTerminal in three cases (cancel.rs:74-92): (1) a running-cancel that LOST the guarded transition because a Worker terminal transition (complete/error) committed first (db::cancel_running_run returns Moved::Lost); (2) a parked-cancel whose pending Proposal disappeared (cancel_parked_run returned false); (3) a Run whose status is already Completed/Errored/Cancelled, classified once by RunStatus::is_terminal (lifecycle.rs:97, cancel.rs:87). The handler (runs/cancel.rs:42) maps this to the wire outcome string 'already_terminal' with no hub, so publish_cancelled is a no-op and no extra terminal event is broadcast. This is a RESULT VALUE, not a JSON-RPC error code (ADR-0029 'protocol error vs result value'; ADR-0014). Edge: the committed terminal status stands — a run that completed before the cancel stays 'completed' (cancel.rs:297 test).

**Key files:** `crates/core/src/cancel.rs:74`, `crates/core/src/cancel.rs:87`, `crates/core/src/db/lifecycle.rs:97`, `crates/core/src/runs/cancel.rs:42`

**Existing coverage:** unit tests cancel.rs running_lost_to_committed_terminal_is_already_terminal, terminal_run_is_already_terminal, parked_race_lost_is_already_terminal; lifecycle.rs run_status_round_trips_and_classifies pins is_terminal

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F157 · Cancelling an unknown run id returns unknown_run — 🟢 impl

*As the owner, I want a cancel request naming a run id that does not exist to be reported as unknown_run, so that the client can settle its Stop control even when Core has no record of the run.*

**Expected behavior.** When db::run_status returns None (no runs row for the id), crate::cancel::cancel returns Outcome::UnknownRun (cancel.rs:58), which the handler maps to the wire outcome string 'unknown_run' (runs/cancel.rs:43) with no hub. Like already_terminal this is a result value, not an error code (ADR-0014/0029). A MALFORMED (non-UUID) run_id is a separate path: it fails at decode_params (runs/cancel.rs:30-34, runs/handler.rs:90) and is framed as invalid_params (-32602) BEFORE the verb runs, because RunCancelParams.run_id is typed Uuid (protocol.rs:53). Edge: a DB read fault inside run_status is the only Err channel and is framed as Internal (-32603) with a generic 'internal error' message (runs/cancel.rs:44, handler.rs:40).

**Key files:** `crates/core/src/cancel.rs:56`, `crates/core/src/runs/cancel.rs:43`, `crates/core/src/runs/cancel.rs:30`, `crates/core/src/protocol.rs:53`

**Existing coverage:** unit test cancel.rs unknown_run_is_unknown_run; handler.rs malformed_id_frames_invalid_params (combinator-level)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F158 · Stop button in the composer cancels the active run — 🟢 impl

*As the owner, I want a Stop button to appear in the composer while a run is active and cancel it when clicked, so that I can abort a streaming or parked run directly from the chat surface.*

**Expected behavior.** ChatColumn reads activeRunId via useActiveRunId (ChatColumn.tsx:48), which is set from the moment a Run streams OR parks and is cleared only by a terminal Run Event (chat.ts:718, comment ChatColumn.tsx:46). ComposeFooter swaps the Send button for a Stop button (square icon, aria-label 'Stop') whenever isRunning (activeRunId !== null) (ComposeFooter.tsx:99-108, ChatColumn.tsx:249). Clicking Stop calls cancelRun(runtime, activeRunId) (ChatColumn.tsx:250). cancelRun (bridge.ts:206) fires run/cancel, then settles the UI off the authoritative response: it interrupts the subscribe fiber, applies a SYNTHETIC RunEvent {kind:'cancelled'} (bridge.ts:249) to settle the bubble, and clears any pending Proposal (clearProposal, bridge.ts:250). Settle rule (bridge.ts:242): it settles for every (outcome,state) EXCEPT already_terminal on a non-parked Run, where the live subscribe stream already owns the real terminal. Edge: a failed run/cancel request is best-effort — caught and the Run left as-is (bridge.ts:218-221); while Stop is shown, Enter/submit must not start a second turn (ComposeFooter.tsx:28-29).

**Key files:** `apps/web/src/components/ChatColumn.tsx:48`, `apps/web/src/components/ChatColumn.tsx:249`, `apps/web/src/components/ComposeFooter.tsx:99`, `apps/web/src/store/bridge.ts:206`, `apps/web/src/store/bridge.ts:242`

**Existing coverage:** tests/e2e/src/run-cancel-ui.spec.ts (gated 2-chunk fixture: send -> partial visible -> click Stop -> bubble shows 'stopped before it finished', Stop gone, Send back, exactly one bubble, gated tail never arrives); run-cancel-parked.spec.ts and run-lifecycle-record.spec.ts also drive Stop while parked

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F159 · Cancelled run shows a neutral stopped bubble, not an error — 🟢 impl

*As the owner, I want a cancelled run's assistant bubble to settle to a neutral 'stopped' state distinct from a provider error, so that I understand I stopped the run myself and that nothing was saved without approval.*

**Expected behavior.** On a 'cancelled' event the chat store marks the message status 'incomplete' with NO error attached (chat.ts:686-693) and settles running tool segments as 'completed' (not 'error'). ChatColumn renders any incomplete message in a destructive-styled bubble (data-testid 'assistant-error', role 'alert') whose text is `message.error ?? 'This reply stopped before it finished. Nothing was saved without your approval.'` (ChatColumn.tsx:485-495). Because cancel attaches no error, the fallback 'stopped before it finished' copy shows — visually distinct from a provider error which carries message.error. Core mirrors this server-side: cancel transitions flip streaming Messages to incomplete (not errored) and write a 'cancelled' run_log row (lifecycle.rs:262-264, 288-290). Edge: the same incomplete bubble offers a 'Try again' retry affordance (ChatColumn.tsx:496-505) when onRetry is provided.

**Key files:** `apps/web/src/store/chat.ts:686`, `apps/web/src/components/ChatColumn.tsx:485`, `apps/web/src/components/ChatColumn.tsx:493`, `crates/core/src/db/lifecycle.rs:262`

**Existing coverage:** tests/e2e/src/run-cancel-ui.spec.ts and run-cancel-parked.spec.ts both assert the bubble toContainText('stopped before it finished') and note it is distinct from run-error.spec.ts's provider message

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F160 · A failed run surfaces an error in the assistant bubble — 🟢 impl

*As the owner, I want a run that fails (provider/worker error) to show the error message on the assistant turn, so that I never see a silent blank or hung bubble when something goes wrong.*

**Expected behavior.** When the Worker emits an explicit error (WorkerStdout::Error), the run loop records worker_error and, after the loop, calls db::error_run_with_message with TerminalReason::Errored, code 'worker_error', and the message (worker/run.rs:131-133, 221-230). On a WON guarded fail() (lifecycle.rs:182) it flips runs.status to errored with error_code/error_message, flips streaming Messages to incomplete, and appends an 'error' run_log row carrying {code,message}. ONLY on the win does the loop broadcast RunEvent::Error{message} (run/run.rs:244-249) — if cancellation already committed, fail() loses and no error event is sent. The web store handles 'error' by setting message.status 'incomplete', attaching event.message as message.error, settling running tool segments as 'error', and clearing activeRunId (chat.ts:675-684). ChatColumn renders message.error in the assistant-error bubble (ChatColumn.tsx:493). Edge: a worker that exits with no done and no error (stdout EOF) takes db::error_run with terminal_reason='worker_disconnected' and message 'worker exited without emitting done event' (db/mod.rs:1546), but publishes NO terminal event (run.rs:253 — (None,false) arm); late subscribers synthesize done via the forwarder.

**Key files:** `crates/core/src/worker/run.rs:131`, `crates/core/src/worker/run.rs:221`, `crates/core/src/worker/run.rs:244`, `crates/core/src/db/mod.rs:1563`, `crates/core/src/db/lifecycle.rs:182`, `apps/web/src/store/chat.ts:675`, `apps/web/src/components/ChatColumn.tsx:493`

**Existing coverage:** tests/e2e/src/run-error.spec.ts (faux fauxError -> assistant-error bubble visible and contains 'the provider is unavailable')

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F161 · Each terminal run records a typed terminal reason — 🟢 impl

*As the owner, I want each ended run to record why it ended (completed, cancelled, errored, worker-disconnected, core-restarted), so that the durable record is trustworthy and distinguishes a clean finish from each failure mode.*

**Expected behavior.** TerminalReason (lifecycle.rs:30) is the single owner of the runs.terminal_reason wire string via as_str() (lifecycle.rs:45): Completed='completed', Cancelled='cancelled', WorkerDisconnected='worker_disconnected', CoreRestarted='core_restarted', Errored='errored'. The transition verbs stamp it: complete() -> Completed (lifecycle.rs:110); fail() -> caller-supplied (Errored for worker error, WorkerDisconnected for EOF — db/mod.rs:1550/1573); cancel()/cancel_running() -> Cancelled (lifecycle.rs:253/279). CoreRestarted is set NOT through the typed seam but by the boot recovery sweep's bulk raw-SQL UPDATE (db/mod.rs:1585 recover_interrupted_runs, terminal_reason='core_restarted') which force-errors every still-'running' Run on Core start (no live Worker survives a restart) while PRESERVING 'parked' Runs. The variant is retained (#[allow(dead_code)]) so the enum is a complete catalog of the runs.terminal_reason CHECK values (lifecycle.rs:37-41). Edge: the enum->string mapping is pinned by a test so a rename that would violate the CHECK fails the test, not a runtime migration.

**Key files:** `crates/core/src/db/lifecycle.rs:30`, `crates/core/src/db/lifecycle.rs:45`, `crates/core/src/db/mod.rs:1546`, `crates/core/src/db/mod.rs:1585`

**Existing coverage:** unit test lifecycle.rs terminal_reason_as_str_matches_check_vocabulary pins all five strings; db/mod.rs error_run test

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F162 · Run status changes only through guarded transition verbs with cancel-wins semantics — 🟢 impl

*As the owner, I want concurrent lifecycle events (a cancel racing a completion) to resolve to exactly one materialized status, so that a run never ends up in two terminal states or double-resumed.*

**Expected behavior.** runs.status is a materialized authoritative column mutated ONLY through typed transition verbs whose `WHERE status=<from>` clause is both legality check and race choke, each returning Moved::{Won,Lost} (ADR-0028; lifecycle.rs:14-27). Legal transitions: running->{completed (complete, lifecycle.rs:110), errored (fail, :182), parked (park, :214), cancelled (cancel_running, :268)}; parked->{running (resume, :235, writes NO run_log row), cancelled (cancel, :242)}. The CANCEL-WINS rule: run/cancel returns 'accepted' only after the running->cancelled or parked->cancelled guard WINS; if a terminal Worker transition wins first the cancel returns already_terminal, and conversely if cancel wins first the Worker loop's terminal tx loses its guard and publishes nothing (worker/run.rs:243 `Ok(moved) if moved.won()`). When cancellation wins after partial output, the same transition marks streaming Messages incomplete, preserving text without treating it as a clean answer (ADR-0028 Consequences). Edge: RunStatus is the exact live-state set — the dead 'pending' value was removed from the enum, CHECK, recovery sweep, and partial index.

**Key files:** `crates/core/src/db/lifecycle.rs:14`, `crates/core/src/db/lifecycle.rs:110`, `crates/core/src/db/lifecycle.rs:268`, `crates/core/src/worker/run.rs:243`, `docs/adr/0028-run-status-materialized-transitions.md:22`

**Existing coverage:** unit tests across cancel.rs (won/lost races) and lifecycle.rs run_status_round_trips_and_classifies; tests/e2e/src/run-cancel.spec.ts asserts no 'done' after a won cancel

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F163 · Reconnect to a live run via snapshot-then-tail — 🟢 impl

*As the owner, I want to re-subscribe to a run and immediately see its accumulated text, then continue receiving live updates, so that a page refresh or returning to a thread mid-stream recovers the live reply.*

**Expected behavior.** run/subscribe (runs/subscribe.rs:23) is snapshot-then-tail (ADR-0022). With a live hub: it takes the per-run gate, reads db::select_run_snapshot (cumulative assistant text + status), subscribes a broadcast receiver, releases the gate (subscribe.rs:36-49) — this lock->snapshot->attach is mutually exclusive with the Worker's lock->persist->publish->unlock so every delta is delivered exactly once. It sends the SubscribeResult {run_id,status='running'}, then the snapshot as a text_delta, then (for Running/Parked status) spawns a tail forwarder (subscribe.rs:57-66, spawn_tail_forwarder:169). The forwarder relays each live RunEvent as a run/event notification; the client's FIRST text_delta after subscribe SETs the bubble (cumulative snapshot) and subsequent deltas APPEND (snapshotArmed bit, chat.ts:638-656). Edge: on RecvError::Lagged (broadcast buffer overflow, HUB_BUFFER=256, hub.rs:21) the forwarder re-reads the persisted snapshot and re-emits it as a cumulative text_delta then resumes — lag degrades to 're-read the truth', never lost text, logged WARN with run_id (subscribe.rs:223-239). On connection drop (out_tx.closed) the forwarder breaks WITHOUT synthesizing done — the Run keeps running under the Worker (subscribe.rs:181, ADR-0012).

**Key files:** `crates/core/src/runs/subscribe.rs:34`, `crates/core/src/runs/subscribe.rs:169`, `crates/core/src/runs/subscribe.rs:223`, `crates/core/src/hub.rs:21`, `apps/web/src/store/chat.ts:638`

**Existing coverage:** tests/e2e/src/background-stream.spec.ts (a backgrounded run keeps streaming and reopening shows the full echo); unit tests subscribe.rs forwarder_lagged_logs_warn_with_top_level_run_id, tail_forwarder_synthesizes_cancelled_on_close_for_a_late_subscriber

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F164 · Reconnect to an already-ended or parked run emits the right closing event — 🟢 impl

*As the owner, I want re-subscribing to a run that has already finished or parked to immediately show its final state without hanging or a false 'done', so that a late reconnect always finalizes the bubble correctly.*

**Expected behavior.** run/subscribe handles late reconnects on two paths. Live-hub-but-terminal (Worker won a terminal transition but hasn't dropped its hub clone, e.g. a cancel while parked in a long tool dispatch): the status read under the gate is already terminal, so the handler emits the snapshot then the matching terminal event and closes WITHOUT attaching — Cancelled->RunEvent::Cancelled, Completed/Errored->RunEvent::Done (subscribe.rs:59-67) — because attaching a receiver positioned after the published event would block on recv() forever. No-hub path (terminal/parked/unknown): it reads db::run_status, sends SubscribeResult with persisted status (or '' for unknown), the snapshot text, then (subscribe.rs:100-108) Parked->emit_pending (push proposal/pending, NO synthesized done — ADR-0025 no-false-done), Cancelled->RunEvent::Cancelled, else (completed/running/errored/unknown)->RunEvent::Done. The forwarder also guarantees a terminal: on channel Closed if it never forwarded a terminal it synthesizes one keyed off persisted status (Parked->proposal/pending, Cancelled->cancelled, else done — subscribe.rs:208-219). Edge: an unknown run id reports status '' and emits a synthesized done (subscribe.rs:83,107), staying defensible.

**Key files:** `crates/core/src/runs/subscribe.rs:57`, `crates/core/src/runs/subscribe.rs:72`, `crates/core/src/runs/subscribe.rs:100`, `crates/core/src/runs/subscribe.rs:116`, `crates/core/src/runs/subscribe.rs:197`

**Existing coverage:** tests/e2e/src/reconnect-parked.spec.ts (reload drops socket, parked Run rehydrates the SAME pending card with no false done, then accept resumes parked->running->completed); unit tests subscribe.rs live_hub_with_terminal_status_emits_cancelled_without_tailing, tail_forwarder_synthesizes_cancelled_on_close_for_a_late_subscriber

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F165 · Cancelling a running run promptly stops the live worker — 🟢 impl

*As the owner, I want cancelling a run to actually halt the underlying worker process, not just flip a status, so that a stopped run stops consuming the provider and producing output.*

**Expected behavior.** run_hub.cancel() flips an in-memory watch channel (hub.rs:35,53 cancel_tx.send_replace(true)). The worker run loop observes this watch (cancel_rx) at multiple checkpoints under the gate: before publishing a tool_call started event (worker/run.rs:165-170), after a tool dispatch returns (run.rs:182-188), and before sending the tool result (run.rs:206-210). On observing cancellation it drops the gate, calls worker.shutdown() (sends EOF so stdout closes), sets cancelled_by_core=true, and breaks. The post-loop terminal block is SKIPPED when cancelled_by_core (run.rs:219 `if !parked && !cancelled_by_core`), so the loop commits NO terminal tx and publishes NO event — run/cancel owns the terminal Cancelled. The hub is removed afterward (run.rs:263). The Worker child is kill_on_drop so no orphan outlives the Run (run.rs:261-262). Edge: the spawn path also checks is_cancelled at each pre-spawn stage (worker/mod.rs:64,72,82) — a cancel landing before the child spawns drops the worker and removes the hub without ever starting the process; the resume spawn path mirrors these checks (worker/mod.rs:161).

**Key files:** `crates/core/src/hub.rs:35`, `crates/core/src/worker/run.rs:165`, `crates/core/src/worker/run.rs:219`, `crates/core/src/worker/mod.rs:64`, `crates/core/src/worker/mod.rs:161`

**Existing coverage:** tests/e2e/src/run-cancel-ui.spec.ts (the gated tail never arrives after Stop, proving the worker stopped); no direct unit test of the worker checkpoints found

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F166 · Run lifecycle milestones are recorded durably — 🟢 impl

*As the owner, I want each run's lifecycle milestones (running, parked, done, error, cancelled, proposal decisions) durably recorded, so that a run's history is trustworthy across process restarts and surfaces in a recent-runs feed.*

**Expected behavior.** Every status-changing transition verb appends its matching run_log row in the SAME transaction as the status flip (ADR-0028 point e): complete->Done (lifecycle.rs:148), fail->Error with {code,message} payload (:210), park->Parked with {awaiting_tool_call_id} (:231), cancel/cancel_running->Cancelled with {target:'run'} (:264/:290), proposal cancel->Cancelled with {target:'proposal',proposal_id} (:394), accept/reject->ProposalDecided (:333/:363). The lone exception is resume (parked->running) which writes NO run_log row (:235) — so a resumed-still-working run's latest milestone reads as proposal_decided, deliberately not re-deriving runs.status (ADR-0028 run-get-history amendment). All appends funnel through run_log::append which owns sequence allocation + insert. The live kind set is exactly seven: running, parked, done, error, cancelled, proposal_pending, proposal_decided. Edge: completion also indexes the finished assistant text into the tier-3 FTS projection best-effort — a failure logs db.fts_index_failed but does NOT roll back the authoritative completion (lifecycle.rs:143-147).

**Key files:** `crates/core/src/db/lifecycle.rs:148`, `crates/core/src/db/lifecycle.rs:210`, `crates/core/src/db/lifecycle.rs:235`, `crates/core/src/db/lifecycle.rs:264`, `crates/core/src/db/run_log.rs`

**Existing coverage:** tests/e2e/src/run-lifecycle-record.spec.ts (park->decide->resume settles one clean bubble, proposal flips pending->accepted in place, no stray pending card); unit tests db/mod.rs cancel_parked_run_records_run_and_proposal_cancel_events

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F167 · ws-connection-drop-and-reconnect — ⚪ gap

**Expected behavior.** CRITIC-FOUND GAP (no story written yet): run-control's 'reconnect-live-run'/'reconnect-terminal-or-parked' are about reattaching to a Run via snapshot-then-tail; they do not cover the transport-level WebSocket lifecycle the user can trigger by losing/regaining connectivity. The ui-sdk supervises one socket: on a post-open drop it fails all in-flight requests with reason 'connection_lost', then bounded-exponential-retries the connection up to 5 times (50ms base), while a first-open failure stays a fatal defect (no retry). Sends issued during the reconnect window block on the writer latch until the fresh connection opens. This is observable behavior (requests rejected then the app silently recovers) with no story.

**Key files:** `/Users/lyuhongy/dev/inkstone/packages/ui-sdk/src/index.ts (lines ~256-312: failPending, hasOpened/firstOpen, supervised retry schedule), docs/design/ui-sdk.md`

**Existing coverage:** none found

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

### Run History & Activity

#### F168 · See a recency-grouped feed of recent runs in the right rail — 🟢 impl

*As the owner, I want a calm list of my agent's recent runs in the chat surface's right rail, grouped by how recently each happened, so that I can glance at what the agent has been doing without leaving the chat.*

**Expected behavior.** The `RunFeed` component (apps/web/src/components/RunFeed.tsx) is mounted as the `rightRail` of the pathless `_chat` layout (routes/_chat.tsx:28-35) with `railLabel="recent runs"`; it renders an `<aside aria-label="Recent runs">` with a 'Runs' header. It reads `useRunHistory()` and groups the returned items into recency buckets via `runHistoryBucket(run.at)` (lib/runHistory.ts:53-60): Today (>= start of local calendar day), Yesterday (>= start of yesterday), 'Earlier this week' (within 6 days), else 'Older'. Buckets render in the fixed `RUN_HISTORY_BUCKET_ORDER` (Today, Yesterday, Earlier this week, Older), and only non-empty buckets are shown (RunFeed.tsx:38-43). Each section has a sticky `<h2>` header. Edge: an empty `runs` array yields zero groups and falls through to the empty state. RunFeed.test.tsx confirms grouping places rows under the correct section header and Today precedes Older in DOM order.

**Key files:** `apps/web/src/components/RunFeed.tsx:22-82`, `apps/web/src/lib/runHistory.ts:53-68`, `apps/web/src/routes/_chat.tsx:28-36`, `apps/web/src/components/RunFeed.test.tsx:89-150`

**Existing coverage:** RunFeed.test.tsx 'renders live history grouped by recency with per-kind labels'; run-history-feed.spec.ts DOM angle

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F169 · Runs are ordered newest-first by latest milestone time — 🟢 impl

*As the owner, I want the most recently active runs at the top of the feed, so that the freshest activity is what I see first.*

**Expected behavior.** Core's `list_run_history` query (crates/core/src/db/queries.rs:1969-1988) orders rows `ORDER BY rl.created_at DESC, rl.run_id DESC` where `created_at` is the latest milestone's timestamp, capped by `LIMIT ?`. The `run/get_history` handler maps rows to `RunHistoryItem { run_id, thread_id, title, kind, at }` preserving that order (run_history.rs:50-61). Within a bucket the feed renders items in the order returned (no re-sort in RunFeed). Edge: when two runs share an identical `created_at` ms value, the `rl.run_id DESC` tie-break makes ordering deterministic (the lexically-greater run_id sorts first) — covered by the `list_run_history_breaks_created_at_ties_by_run_id` DB test. The e2e wire test asserts run B (created+completed second) precedes run A and `runs[0].at >= runs[1].at`.

**Key files:** `crates/core/src/db/queries.rs:1969-1988`, `crates/core/src/runs/run_history.rs:50-61`, `crates/core/src/db/mod.rs:3027-3043`, `tests/e2e/src/run-history-feed.spec.ts:123-135`

**Existing coverage:** run-history-feed.spec.ts wire angle; db/mod.rs list_run_history_orders_by_recency_with_verbatim_kind and list_run_history_breaks_created_at_ties_by_run_id

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F170 · Each run shows its latest lifecycle milestone, returned verbatim — 🟢 impl

*As the owner, I want each row to reflect the run's most recent lifecycle moment (running, waiting, done, failed, cancelled), so that I can tell at a glance what state each run reached.*

**Expected behavior.** Core selects, per run, the maximum-`run_seq` Run Log row via the correlated subquery `WHERE rl.run_seq = (SELECT MAX(run_seq) FROM run_log WHERE run_id = rl.run_id)` and returns its `kind` UNMAPPED (queries.rs:1969-1988, run_log.rs:14-37). The seven possible kinds are running, parked, done, error, cancelled, proposal_pending, proposal_decided. Core deliberately does NOT fold these into the five `runs.status` values (protocol.rs:295-309, ADR-0028 as-built amendment). A run always has at least its creation `running` row at seq 0, so the inner join never drops a run. Edge/important: because `resume` (parked→running) writes no Run Log row, a resumed-still-working run's latest milestone is `proposal_decided`, not `running` — verified by `list_run_history_orders_by_recency_with_verbatim_kind` ('middle resumed' surfaces `proposal_decided'). The reader is read-only; it reads the Run Log, it does not mutate or project `runs.status`.

**Key files:** `crates/core/src/db/queries.rs:1956-1988`, `crates/core/src/db/run_log.rs:14-54`, `crates/core/src/protocol.rs:295-317`, `crates/core/src/db/mod.rs:2957-3022`

**Existing coverage:** db/mod.rs list_run_history_orders_by_recency_with_verbatim_kind; run-history-feed.spec.ts asserts kind 'done' verbatim and parked→'Waiting'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F171 · Milestone kinds map to human labels, icons, and tone in the client — 🟢 impl

*As the owner, I want each run's status shown with a clear word, an icon, and a restrained color, so that I can read state without relying on color alone.*

**Expected behavior.** The Web client owns kind→presentation in `RUN_HISTORY_VIEWS` (lib/runHistory.ts:27-40): running→'Running'/LoaderCircle/active, proposal_decided→'Running, resumed'/LoaderCircle/active, proposal_pending→'Waiting'/Clock/active, parked→'Waiting'/Clock/active, done→'Done'/Check/neutral, cancelled→'Cancelled'/Ban/neutral, error→'Failed'/TriangleAlert/alert. Tone maps to a text color class via `RUN_HISTORY_TONE_CLASS` (active→text-primary magenta, neutral→text-muted-foreground, alert→text-destructive; runHistory.ts:44-48). Each `RunRow` renders the icon (tinted by tone) plus a second line `{view.label} · {formatRunTime(run.at)}` (RunFeed.tsx:84-112). Both icon and word carry the kind (icon is never the only signal). Edge: proposal_pending and parked both read 'Waiting'. Edge: if a `kind` outside the seven arrives, `RUN_HISTORY_VIEWS[run.kind]` is undefined and `view.icon`/`view.label` would throw — there is no fallback view (unlike ToolActivity's humanize fallback).

**Key files:** `apps/web/src/lib/runHistory.ts:27-48`, `apps/web/src/components/RunFeed.tsx:84-112`

**Existing coverage:** RunFeed.test.tsx asserts Done/Running, resumed/Failed/Waiting labels render

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F172 · Each run row is labeled by its owning thread's title — 🟢 impl

*As the owner, I want each run identified by the conversation it belongs to, so that I can recognize which chat produced it.*

**Expected behavior.** Core's query joins `runs.thread_id → threads.title` (queries.rs:1977-1981) and returns `title` as a one-join human label; per ADR-0028 it deliberately does NOT walk user_message_id→messages→message_parts to the run prompt, and the old derived 'changes' count from UI mocks is dropped. `RunRow` renders `run.title` as the truncating primary line (RunFeed.tsx:101-104). The e2e wire test confirms titles 'second run beta' / 'first run alpha' come through. Edge: titles are truncated (`truncate`) so long titles don't break layout; `thread_id` is also returned and is distinct per run (asserted in run-history-feed.spec.ts:135).

**Key files:** `crates/core/src/db/queries.rs:1976-1988`, `crates/core/src/protocol.rs:295-309`, `apps/web/src/components/RunFeed.tsx:101-108`

**Existing coverage:** run-history-feed.spec.ts asserts titles; RunFeed.test.tsx renders title text

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F173 · Each run row shows a relative time/date stamp — 🟢 impl

*As the owner, I want a compact timestamp on each run, so that I know roughly when it happened.*

**Expected behavior.** `formatRunTime(at)` (lib/runHistory.ts:72-82) shows a clock time (`hour: numeric, minute: 2-digit` via toLocaleTimeString) for runs from today (at >= start of local today) and a compact month/day (toLocaleDateString) for older runs. Rendered on the row's second line after the label: `{view.label} · {formatRunTime(run.at)}` (RunFeed.tsx:105-107). The `at` value is the latest milestone's ms-epoch `created_at` (protocol.rs RunHistoryItem.at). Both `runHistoryBucket` and `formatRunTime` default `now` to `Date.now()`, so boundaries are computed against the current local calendar day.

**Key files:** `apps/web/src/lib/runHistory.ts:72-82`, `apps/web/src/components/RunFeed.tsx:105-107`

**Existing coverage:** RunFeed.test.tsx pins Date.now() and asserts '/Done ·/' style labels (time stamp adjacent)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F174 · Click a run row to open its thread — 🟢 impl

*As the owner, I want clicking a run to take me to its conversation, so that I can jump straight into the chat that produced that run.*

**Expected behavior.** Each `RunRow` is a `<button>`; `onClick` calls `onOpen()` → `onOpenThread(run.thread_id)` (RunFeed.tsx:68-93). The `_chat` layout wires `onOpenThread` to navigate to `/thread/$threadId` with `params: { threadId }` (routes/_chat.tsx:29-33). RunFeed.test.tsx confirms clicking the row calls `onOpenThread` with the correct `thread_id` ('thread-42'). The button is reachable by accessible name (the title) — the test finds it via `getByRole('button', { name: /Clickable/ })`.

**Key files:** `apps/web/src/components/RunFeed.tsx:68-93`, `apps/web/src/routes/_chat.tsx:23-33`

**Existing coverage:** RunFeed.test.tsx 'opens a run's thread when its row is clicked'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F175 · Feed shows distinct loading, empty, and error states — 🟢 impl

*As the owner, I want clear feedback when the feed is loading, has no runs, or fails to load, so that I understand the surface's state instead of staring at a blank or spinner.*

**Expected behavior.** `RunFeed` branches on the TanStack Query state from `useRunHistory()` (RunFeed.tsx:27,55-78): `isPending`→`<FeedSkeleton>` (4 animated placeholder rows, `data-testid="run-feed-skeleton"`, not a spinner); `isError`→`<FeedError>` ('Couldn't load run history.' with a 'Try again' button calling `refetch()`); empty groups→`<FeedEmpty>` ('No runs yet' / 'Runs appear here as you chat.'); otherwise the grouped list. Crucially `useRunHistory` (lib/hooks/useRunHistory.ts) does NOT swallow a Core-unreachable read to an empty list — it surfaces as `isError` so the error state (not the empty state) is shown. Edge: the retry button re-runs the query; RunFeed.test.tsx confirms a failed first read shows the error, and after clicking 'Try again' a successful second read renders the recovered run and clears the error.

**Key files:** `apps/web/src/components/RunFeed.tsx:54-160`, `apps/web/src/lib/hooks/useRunHistory.ts:12-25`

**Existing coverage:** RunFeed.test.tsx 'shows a teaching empty state', 'shows a skeleton loading state', 'shows an error state with a working retry'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F176 · Run history is bounded by a default and hard-capped limit — 🟢 impl

*As the owner, I want the feed to return a sensible number of recent runs and never trigger a huge read, so that the feed stays fast and the log doesn't need paging.*

**Expected behavior.** `run/get_history` accepts optional `limit` (RunGetHistoryParams, protocol.rs:287-293; TS schema RunGetHistoryParams in packages/protocol). The handler (run_history.rs:32-44): omitted/null params → defaults; a non-positive or absent limit → `RUN_HISTORY_DEFAULT_LIMIT` (50); a positive limit is clamped via `.min(RUN_HISTORY_MAX_LIMIT)` (200). There is no keyset/cursor paging (single-user log, ADR-0007). The web hook calls `client.getRunHistory()` with no limit, so the default 50 applies (useRunHistory.ts:21). Edge: a present-but-malformed `limit` (e.g. a string) is a real `invalid_params` error (HandlerError::InvalidParams, run_history.rs:35-37). Edge: the only other failure mode is an internal DB error mapped to HandlerError::Internal (run_history.rs:46-48). The `list_run_history_orders_by_recency_with_verbatim_kind` test confirms `limit=2` caps to 2 rows keeping the newest.

**Key files:** `crates/core/src/runs/run_history.rs:13-63`, `crates/core/src/protocol.rs:287-293`, `apps/web/src/lib/hooks/useRunHistory.ts:12-25`

**Existing coverage:** db/mod.rs list_run_history capped read assertion; ui-sdk index.test.ts 'getRunHistory(limit) sends run/get_history with { limit }'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F177 · Feed refreshes after sending a message or retrying a run — 🟢 impl

*As the owner, I want the recent-runs feed to update after I send a message or retry a failed turn, so that the new/advanced run appears without a manual reload.*

**Expected behavior.** The feed is a one-shot read via TanStack Query under the `["run-history"]` key (useRunHistory.ts:14-16), not a live stream. `ChatColumn` invalidates that query after every send path: `onSend` (both the existing-thread `send` and mint-on-send `sendNewThread` branches) awaits `queryClient.invalidateQueries({ queryKey: ["run-history"] })` (ChatColumn.tsx:278-280), and the `retry` path does the same after re-issuing a turn (ChatColumn.tsx:199-201). Invalidation triggers a refetch that re-reads `run/get_history`, so a send that births or advances a run surfaces in the feed. Edge: the parked-run e2e relies on reload rather than live push — the feed does not subscribe to the run stream, so an in-flight status change only appears after a refetch/reload (run-history-feed.spec.ts:152-163 reloads to re-read).

**Key files:** `apps/web/src/components/ChatColumn.tsx:189-202,253-280`, `apps/web/src/lib/hooks/useRunHistory.ts:12-25`

**Existing coverage:** run-history-feed.spec.ts parked-run DOM test (reload re-reads and shows 'Waiting')

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F178 · See a live tool-call activity row inside an assistant turn — 🟢 impl

*As the owner, I want to see when the agent calls a tool, with a label and progress, inside the reply, so that I understand what the agent is doing mid-turn.*

**Expected behavior.** When a `tool_call` Run Event arrives (chat.ts:659-673), the store upserts a `tool_call` segment into the assistant message's ordered `segments[]` timeline: `started`→a `running` segment; a terminal status flips the matching segment in place by call id (upsertToolSegment, chat.ts:492-509). `AssistantBubble` folds consecutive tool_call segments into one `ToolActivity` render group via `toRenderGroups` (ChatColumn.tsx:399-416,444-450). `ToolActivity` renders a `<ul aria-label="Tool activity" aria-live="polite">` with one `<li data-testid="tool-call" data-status=...>` per group (ToolActivity.tsx:130-148). A running row shows the active-tense label, the tool glyph with a glow animation; a completed row shows the past-tense label with a Check (pop animation); the label/icon come from `presentation(name)`. Edge: while a tool is running and there's no text yet, the typing indicator is suppressed (`!toolRunning`, ChatColumn.tsx:430-432,468). Edge: empty toolCalls renders nothing (returns null, ToolActivity.tsx:135). The e2e asserts the row settles to `data-status="completed"` with 'Read this thread' and 'read-only'.

**Key files:** `apps/web/src/components/ToolActivity.tsx:129-223`, `apps/web/src/store/chat.ts:659-673,492-509`, `apps/web/src/components/ChatColumn.tsx:388-450`

**Existing coverage:** tool-activity.spec.ts 'a read_thread call renders a completed, read-only tool-activity row'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F179 · Tool rows show humanized labels, glyphs, and read-only chips per tool — 🟢 impl

*As the owner, I want each tool's row to read in plain language with an appropriate icon, and to mark read-only tools, so that I can tell what the agent did and whether it could change anything.*

**Expected behavior.** `TOOL_PRESENTATION` (ToolActivity.tsx:21-39) maps known tools: read_thread→'Reading this thread'/'Read this thread'/BookOpen/access:read, search_entities→'Searching entities'/'Searched entities'/Search/access:read, load_skill→'Loading skill'/'Loaded skill'/Sparkles. Unknown tools fall back to a humanized label (underscores/dashes→spaces, capitalized) with the Wrench icon and no access tag (humanize + presentation, ToolActivity.tsx:41-52). A running row uses the active label; a settled row uses the done label (ToolActivity.tsx:155). Read-only access shows a '· read-only' chip, but only when not errored (`readOnly = access === 'read' && !errored`, ToolActivity.tsx:156,208-212). An errored row shows a 'failed' chip and AlertTriangle, styled with destructive tones (ToolActivity.tsx:153,188-189,213-217). A single screen-reader-only string announces state once (running/failed/done, plus arg phrase and ', read-only'), while visible labels are aria-hidden to avoid double-speak (ToolActivity.tsx:163-167,219-220).

**Key files:** `apps/web/src/components/ToolActivity.tsx:13-52,150-223`

**Existing coverage:** tool-activity.spec.ts asserts 'Read this thread' + 'read-only'; ToolActivity.test.tsx grouped rendering

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F180 · Repeated tool calls collapse into one grouped row; errored calls break out — 🟢 impl

*As the owner, I want repeated calls of the same tool shown as a single tidy row, with failures called out separately, so that the turn isn't cluttered and a failed call isn't buried among successes.*

**Expected behavior.** `groupToolCalls` (ToolActivity.tsx:76-127, ADR-0043) merges non-errored calls of the same tool name into one group (key `group:<name>`): args are trimmed, deduped, and joined in first-seen order; aggregate `status` is 'running' if ANY member is in flight, else the merged status. Each errored call breaks out into its own group (key = the call id) so the failed arg is never buried; groups are ordered by first occurrence, with an errored break-out at the position of its first errored call. Visible args are capped at MAX_VISIBLE_ARGS (3); extras fold into a `+N` overflow chip computed over the whole group (ToolActivity.tsx:54-55,118-124,157-161). The arg text renders as `· arg1, arg2, arg3 +N`. Edge: an argless tool yields a group with empty args (no arg text). Distinct tools stay in separate groups ordered by first occurrence. ToolActivity.test.tsx covers all these cases.

**Key files:** `apps/web/src/components/ToolActivity.tsx:54-127,157-207`

**Existing coverage:** ToolActivity.test.tsx 'groupToolCalls' suite and 'ToolActivity grouped rendering' suite

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F181 · Running tool rows settle when the run ends — 🟢 impl

*As the owner, I want a tool row that was still 'running' to resolve when the run finishes, errors, or is cancelled, so that I never see a tool stuck in-progress after the turn is over.*

**Expected behavior.** On a terminal Run Event the store settles any still-running tool_call segments: `done` (chat.ts:696-699) and `cancelled` (chat.ts:686-694) settle running tool segments to 'completed' via settleRunningToolSegments; `error` (chat.ts:675-684) settles them to 'error' and marks the message incomplete (settleRunningToolSegments(m.segments, "error"), chat.ts:511-522). This covers the lost-boundary case where a tool's terminal `tool_call` event never arrived. Cancelled is terminal-but-not-a-failure (no `error` attached), so its tool rows settle to completed, not error. The aggregate group status then reflects the settled member statuses.

**Key files:** `apps/web/src/store/chat.ts:511-522,675-699`

**Existing coverage:** none found (no dedicated e2e for cancel/error tool-settle; covered indirectly by store tests)

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F182 · Tool-call activity survives a page reload — 🟢 impl

*As the owner, I want tool-activity rows to still be there after I refresh the page, so that the record of what the agent did isn't lost on reload.*

**Expected behavior.** Per ADR-0043 (superseded in part by ADR-0045), `thread/get` folds persisted tool calls into the ordered `MessageView.segments[]` as `tool_call` segments (excluding the Proposal tool call, and excluding `pending`/in-flight rows — only settled history rehydrates). On cold load the store reinitializes empty, and `hydrate.toSegment` (store/hydrate.ts:39-61) rebuilds each `tool_call` segment with a synthesized stable id `<messageId>:seg:<index>`, mapping wire status via `toToolCallStatus` (error→error, everything else→completed; a rehydrated call is never running; hydrate.ts:25-30). `AssistantBubble` renders the rehydrated segments through the SAME `toRenderGroups`+`ToolActivity` path as live, so live and reloaded render identically. The e2e drives a real read_thread call, waits for the turn to persist, cold-reloads the same `/thread/<id>` URL, and asserts exactly one `tool-call` row rehydrates with `data-status="completed"` and 'Read this thread'.

**Key files:** `apps/web/src/store/hydrate.ts:25-61`, `apps/web/src/components/ChatColumn.tsx:399-450`, `docs/adr/0043-tool-activity-rehydration.md:34-62`

**Existing coverage:** tool-activity-reload.spec.ts 'a tool-activity row survives a page reload'

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F183 · Activity Rail (edits + automations) — visual-only mock, not wired — 🔵 stub/mock

*As the owner, I want an activity rail showing recent edits and automation runs grouped by recency with filter pills, so that I can review applied edits and automation activity.*

**Expected behavior.** `ActivityRail` (apps/web/src/components/ActivityRail.tsx) is explicitly 'VISUAL ONLY — automation rows are out of scope per ADR-0010; rendered from mock data' (file header line 1). It renders an `<aside aria-label="Activity">` with filter pills (all/edits/automations, aria-pressed) and Today/Yesterday/Earlier sections (ActivityRail.tsx:21-68). Rows come from `useActivityRows` (lib/hooks/useActivityRows.ts), which builds EditRows from applied proposals (filtered to `p.appliedAt`) and AutomationRows from `useAutomationRuns`/`useAutomations` (all mock data from @/data/mock/automations and proposals). The 'edits' filter shows only `kind==="edit"`, 'automations' only `kind==="automation"` (ActivityRail.tsx:25-30). Recency is bucketed by string parsing in `classify` (lib/activity.ts:3-9): a string starting 'today' or a leading `HH:MM` →today, 'yesterday'→yesterday, else earlier. Empty sections render 'None'. IMPORTANT/edge: this component is NOT mounted in any route (the `_chat` rightRail is `RunFeed`, not `ActivityRail`); `useAutomationRuns`/`useAutomations` are TanStack queries returning static mock arrays as both queryFn and placeholderData (no Core call). So this is a stubbed/dormant surface superseded by RunFeed.

**Key files:** `apps/web/src/components/ActivityRail.tsx:1-135`, `apps/web/src/lib/hooks/useActivityRows.ts:23-52`, `apps/web/src/lib/hooks/useAutomationRuns.ts:4-10`, `apps/web/src/lib/hooks/useAutomations.ts:4-10`, `apps/web/src/lib/activity.ts:3-9`

**Existing coverage:** ActivityRail.test.tsx 'groups rows into Today/Yesterday/Earlier and filter pill hides automations' (unit only, against mock data)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F184 · Automations and automation-run hooks are mock-backed placeholders — 🔵 stub/mock

*As the owner, I want automation definitions and their run history available to the activity surfaces, so that automation activity can be displayed.*

**Expected behavior.** `useAutomations` (lib/hooks/useAutomations.ts) and `useAutomationRuns` (lib/hooks/useAutomationRuns.ts) are TanStack Query hooks whose `queryFn` simply returns the static arrays `automations`/`automationRuns` from @/data/mock/automations, with the same array as `placeholderData` (so data is available synchronously, never loading/erroring). They make no Core/WebSocket call — there is no `run/` or automation RPC behind them. `useActivityRows` joins automation runs to their definitions by id (`automationsById.get(r.automationId)?.name ?? "Automation"`, useActivityRows.ts:30,41-47), falling back to the literal 'Automation' when no definition matches. These hooks are consumed only by the unmounted `ActivityRail`, so automations are not a live feature — they are scaffolding/mock data (ADR-0010 marks automation rows out of scope).

**Key files:** `apps/web/src/lib/hooks/useAutomations.ts:1-11`, `apps/web/src/lib/hooks/useAutomationRuns.ts:1-11`, `apps/web/src/lib/hooks/useActivityRows.ts:23-52`

**Existing coverage:** ActivityRail.test.tsx exercises these hooks indirectly via mock data

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

### Agent / Worker / Skills

#### F185 · Agent reads another thread's messages by id — 🟢 impl

*As the owner, I want the assistant to pull in the contents of a different thread when I reference it by id, so that it can answer questions or capture using context that lives in another conversation.*

**Expected behavior.** `read_thread` (crates/core/src/tools/read_thread.rs) takes `{thread_id}`, parses it as a UUID, and via `db::get_thread_with_messages` returns a JSON text block `{thread_id, title, messages:[{role, text}]}` with messages in chronological order (db/mod.rs:482, ordered by (created_at, rowid) so the user message precedes the assistant message on a same-ms insert). Message text is the concatenation of the assistant turn's text segments only (MessageRow::text, mod.rs:467 — tool/proposal segments excluded). Edge/error states: a non-UUID `thread_id` → ToolError code `not_found` (does NOT fail the Run); an unknown but well-formed UUID → `not_found`; a DB error → `internal`; malformed/missing `thread_id` field → `invalid_params`. The tool re-validates the model's args against the typed Input (ADR-0018). It is allowlisted in default.toml.

**Key files:** `crates/core/src/tools/read_thread.rs:39`, `crates/core/src/db/mod.rs:482`, `crates/core/src/db/mod.rs:467`, `crates/core/workflows/default.toml:135`

**Existing coverage:** tests/e2e/src/tool-read-thread.spec.ts (cross-thread read round-trip via faux tool-call worker); crates/core/tests/tool_protocol.rs

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F186 · Agent reads accepted journal entries created from the current thread — 🟢 impl

*As the owner, I want the assistant to look up the journal entries it previously created from this same conversation before correcting or deleting one, so that 'fix that entry' / 'delete that one' resolves to the right entry without me re-stating it and without touching another thread's entries.*

**Expected behavior.** `read_current_thread_journal_entries` (tools/read_current_thread_journal_entries.rs) takes NO model args — Core derives the thread from the Run's `run_id` (PoolRun dispatch). It returns `{entries:[{entity_id, occurred_at, ended_at?, body}]}` for journal_entry entities whose latest revision was `created_from` a USER message in the current Run's thread, newest revision first (db/queries.rs:585 — WITH latest_revisions, filter type='journal_entry', EXISTS over runs→messages(role='user')→entity_sources(relation='created_from'), ORDER BY created_at DESC, seq DESC, id DESC). `ended_at` is omitted when null; `occurred_at`/`body` default to JSON null if missing. The default workflow's system_prompt instructs the model to call this (with `{}`) for same-thread corrections/deletions and forbids cross-thread update/delete. Error states: malformed (non-`{}`) params → `invalid_params`; DB error → `internal`.

**Key files:** `crates/core/src/tools/read_current_thread_journal_entries.rs:32`, `crates/core/src/db/queries.rs:585`, `crates/core/src/db/mod.rs:404`, `crates/core/workflows/default.toml:15`

**Existing coverage:** crates/core/tests/current_thread_journal_entries.rs (Core integration test: reads only accepted JEs created from this thread, newest first)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F187 · Agent searches accepted People, Projects, and Todos — 🟢 impl

*As the owner, I want the assistant to find existing people/projects/todos by name before it captures or links anything, so that it reuses entities I already have instead of creating duplicates.*

**Expected behavior.** `search_entities` (tools/search_entities.rs) takes `{type, query, limit?}`. `type` is a closed snake_case enum person|project|todo (the JSON schema rejects `journal_entry` and arbitrary types → `invalid_params`). It searches ACCEPTED entities only via `db::list_by_type`, matching a case-insensitive substring of the label (`name` for person/project, `title` for todo) or — for person only — any `aliases` entry. An empty query matches all of that type. Returns `{results:[{id, type, label, aliases?}]}` (aliases only on person rows that have them). `limit` defaults to 20 (DEFAULT_LIMIT) and is hard-capped at 50 (MAX_LIMIT) — an over-large limit clamps, the limit is applied after filtering. No arbitrary SQL or table-level CRUD is exposed. Allowlisted in default.toml; the system prompt directs the model to query by short base names, not full sentences.

**Key files:** `crates/core/src/tools/search_entities.rs:90`, `crates/core/src/tools/search_entities.rs:25`, `crates/core/src/tools/search_entities.rs:20`, `crates/core/workflows/default.toml:68`

**Existing coverage:** Unit tests in search_entities.rs (name/alias match, todo title, project name, empty-query, limit clamp, invalid type). Exercised indirectly by extraction e2e specs. No dedicated e2e for the tool itself.

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F188 · Agent loads a skill procedure by name mid-run — 🟢 impl

*As the owner, I want the assistant to pull a relevant procedure (e.g. weekly review, inbox triage) into context and follow it when my request matches, so that complex multi-step workflows run consistently without me spelling out every step.*

**Expected behavior.** `load_skill` (tools/load_skill.rs) takes `{name}` and returns the skill's markdown body (frontmatter stripped) as tool text so the model can follow it (ADR-0036 progressive disclosure: descriptions are advertised up front, bodies ride back only on load). `name` is a key into the skills dir, never a path: `is_single_component` rejects traversal/absolute/separator/`.`/`..`/empty names → `unknown_skill`. Resolution goes through the SAME `skills::eligible` gate discovery uses (`skills::load_body`), so a present-but-ineligible skill (missing/mismatched/unsafe frontmatter) is `unknown_skill` (NOT loadable by name), guaranteeing the loadable set equals the advertised set. Error states: absent or discovery-ineligible → `unknown_skill`; present-but-unreadable (permission, non-UTF-8, transient I/O, skills-dir resolution failure) → `internal` (so the model is not told a real skill doesn't exist); unclosed frontmatter fence → `malformed_skill`; malformed params → `invalid_params`. Never panics. The tool needs no pool and no run_id (NoContext dispatch).

**Key files:** `crates/core/src/tools/load_skill.rs:88`, `crates/core/src/tools/load_skill.rs:70`, `crates/core/src/skills.rs:342`, `crates/core/src/skills.rs:240`

**Existing coverage:** tests/e2e/src/skill-activation.spec.ts (browser-level: ambient load_skill call renders a completed tool-activity row, body round-trips); crates/core/tests/skills_load_skill.rs (real dispatch round-trip); unit tests in load_skill.rs (unknown/unreadable/malformed/ineligible/unsafe-name)

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F189 · Available skills are advertised in every run's system prompt — 🟢 impl

*As the owner, I want the assistant to be aware of which skills exist (by name and one-line description) on each run, so that it can choose the most specific applicable skill (or none) without me telling it the menu.*

**Expected behavior.** On each run, `skills::augmented_system_prompt(workflow)` (skills.rs:397, called from worker/mod.rs:223/244/359/402) scans `<skills dir>/*/SKILL.md` and appends an `<available_skills>` block to the workflow's system_prompt. The block carries a fixed instruction ("If one clearly applies, load it with the `load_skill` tool... if several apply, choose the most specific; if none apply, load none") plus one `- name: description` line per ELIGIBLE skill, sorted by name (skills.rs:154 `scan`, :365 `render_available_skills`). Eligibility (skills.rs:240 `eligible`): SKILL.md parses, has non-empty frontmatter `name` AND `description`, and the frontmatter `name` equals the directory name. Scanning happens per call, so dropping in a skill makes the next run see it (no restart). Edge cases: no eligible skills → the prompt is returned unchanged (no block); a skills-dir resolution failure degrades to the bare prompt (never fails the run); descriptions with interior newlines (YAML `|`/`>-`) are collapsed to one line.

**Key files:** `crates/core/src/skills.rs:397`, `crates/core/src/skills.rs:160`, `crates/core/src/skills.rs:365`, `crates/core/src/worker/mod.rs:223`

**Existing coverage:** Unit tests in skills.rs (scan eligibility/sorting, render block, augment appends/leaves-untouched, bundled seeds eligible). Indirectly exercised by skill-activation.spec.ts.

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F190 · Untrusted skill metadata cannot break out of the advertised-skills block — 🟢 impl

*As the owner, I want a dropped-in skill file to be unable to inject instructions into the system prompt that read as if Inkstone authored them, so that a malicious or malformed SKILL.md cannot hijack the agent via the auto-injected disclosure block.*

**Expected behavior.** Because skill name+description are auto-injected into every run's system prompt with no opt-in (ADR-0036 Trust), `skills::eligible` (skills.rs:289) DROPS any skill whose `name` or `description` contains the delimiter substring `available_skills` or any control character (ESC/NUL/etc.). Descriptions are whitespace-collapsed to a single line first (so a YAML literal block's newlines can't forge extra `- ` lines), but non-whitespace control chars survive collapsing and are rejected separately. `name` is only trimmed (collapsing would break the name==dir_name round-trip), so its control-char check matters independently. A frontmatter `name` that disagrees with the directory name is dropped (would advertise an unloadable name). Each drop is logged (warn) and is fail-soft — one bad file never aborts the run or boot. The same gate backs `load_skill`, so a dropped skill is also not loadable by name.

**Key files:** `crates/core/src/skills.rs:289`, `crates/core/src/skills.rs:266`, `crates/core/src/skills.rs:299`, `crates/core/src/skills.rs:251`

**Existing coverage:** Unit tests in skills.rs: scan_neutralizes_unsafe_descriptions (delimiter injector, newline name, ESC desc dropped), scan_returns_eligible_skills_sorted_dropping_the_rest (name mismatch, bad YAML, missing field). load_skill.rs: present_but_discovery_ineligible_skills_are_unknown_not_loadable.

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F191 · Bundled example skills are seeded on first run and respect user edits — 🟢 impl

*As the owner, I want the weekly-review and inbox-triage skills to exist out of the box on a fresh install, but my later edits/deletes to survive, so that the skills feature is usable immediately without defeating drop-in ownership of the skills directory.*

**Expected behavior.** At Core boot `skills::seed_if_absent()` (skills.rs:412, called from main.rs:73) writes the two compile-time-embedded bundled skills (weekly-review, inbox-triage) into the skills dir ONLY when the dir does not yet exist. Once the dir exists it is the user's: deletes survive and it never re-seeds (so removing weekly-review leaves only inbox-triage on next boot). Skills dir is `<OS data dir>/inkstone/skills/`, overridable via `INKSTONE_SKILLS_DIR` (an empty override is treated as unset, falling back to the data dir rather than process CWD). Best-effort: a seed write failure is logged, never fatal (the feature just ships no skills until one is dropped in). Both bundled SKILL.md files are themselves valid/eligible.

**Key files:** `crates/core/src/skills.rs:412`, `crates/core/src/skills.rs:90`, `crates/core/src/main.rs:73`, `crates/core/skills/weekly-review/SKILL.md:1`

**Existing coverage:** Unit tests in skills.rs: seed_if_absent_populates_then_respects_user_deletes, empty_skills_dir_env_falls_back_to_data_dir, bundled_seed_skills_are_eligible. skills_load_skill.rs relies on boot seeding.

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F192 · The Dispatcher picks a workflow once per fresh run — 🟢 impl

*As the owner, I want each new run to be assigned a workflow (system prompt + tool allowlist + provider) at creation time, so that my conversation behaves consistently and a mid-run settings change can't leak into a running run.*

**Expected behavior.** `dispatcher::dispatch_and_resolve` (dispatcher.rs:23) is the single seam every fresh Run-creation site shares (runs/thread_create.rs:57, runs/post_message.rs:45) — ADR-0011 'asked once, in one place'. `dispatch` (dispatcher.rs:32) currently always returns the single `workflow::default_workflow()` regardless of thread_id/prompt (one workflow today; the signature carries thread_id+prompt for future routing). Resume does NOT call the dispatcher — a resumed run rebuilds its workflow from the `runs` snapshot (`db::run_workflow_snapshot`), so a setting changed mid-run never affects the live run (ADR-0024). The run's `runs` row records the resolved provider/model (sourced from default.toml + settings, not hardcoded).

**Key files:** `crates/core/src/dispatcher.rs:23`, `crates/core/src/dispatcher.rs:32`, `crates/core/src/runs/thread_create.rs:57`, `crates/core/src/runs/post_message.rs:45`

**Existing coverage:** crates/core/tests/run_records_workflow.rs (run row records workflow provider/model from default.toml via dispatcher); crates/core/tests/resume_uses_run_snapshot.rs; crates/core/tests/run_uses_selected_model.rs

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F193 · The run's model and effort are resolved from the user's settings — 🟢 impl

*As the owner, I want my configured model and reasoning effort to be applied to each run, so that the assistant uses the provider/model and thinking level I selected, with a safe default when unset.*

**Expected behavior.** `dispatcher::resolve_effective_workflow` (dispatcher.rs:46) clones the dispatched base workflow and overrides `model` and `thinking_level` from settings. Model resolution order: user setting (settings::preferred_model) → provider default (models::default_model) → TOML `model` → empty string. Effort order: user setting (settings::effort_setting) → TOML `thinking_level` → settings::DEFAULT_EFFORT. The returned workflow always carries concrete model+thinking_level (the wire manifest requires them). Edge case: a settings READ error is treated as 'unset' so a transient DB hiccup falls back to the default rather than failing the run. `thinking_level` must be one of off|minimal|low|medium|high|xhigh (workflow.rs:17 THINKING_LEVELS) — validated at workflow load and shared with the settings/set effort validator.

**Key files:** `crates/core/src/dispatcher.rs:46`, `crates/core/src/workflow.rs:17`, `crates/core/src/workflow.rs:21`, `crates/core/src/dispatcher.rs:57`

**Existing coverage:** crates/core/tests/run_uses_selected_model.rs; crates/core/tests/settings_get_set.rs (effort validation). No direct unit test of resolve_effective_workflow fallbacks observed.

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F194 · The default workflow defines the agent's system prompt and tool allowlist — 🟢 impl

*As the owner, I want the assistant to operate under a single declarative workflow that decides what it knows and which tools it may call, so that the agent's capabilities are bounded and consistent, defined in data rather than ad-hoc code.*

**Expected behavior.** `default.toml` declares name/version/provider (openai-codex), a long GTD-oriented system_prompt, and `tools = [read_thread, read_current_thread_journal_entries, propose_workspace_mutation, search_entities]`. It is loaded once into a process-global OnceLock at boot (workflow::init), failing FAST on a missing file, malformed TOML, or an invalid thinking_level. The shipped default.toml authors no model/thinking_level (those come from settings, ADR-0024). The run's wire manifest ships exactly the allowlisted descriptors in order, plus any ambient tool not already listed (tools::run_descriptors, mod.rs:162). The dispatch gate (`tools::is_allowed`, mod.rs:178; enforced in worker/run.rs:294) requires a tool be registered AND (allowlisted OR ambient): an off-allowlist or unregistered tool_request is rejected with `tool_not_allowed` and persists nothing.

**Key files:** `crates/core/workflows/default.toml:135`, `crates/core/src/workflow.rs:78`, `crates/core/src/tools/mod.rs:162`, `crates/core/src/worker/run.rs:294`

**Existing coverage:** crates/core/tests/workflow_load.rs (load/validate/fail-fast); tools/mod.rs unit tests (descriptors_for, is_allowed, run_descriptors order); worker/run.rs gate exercised by tool_protocol.rs

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F195 · load_skill is always available regardless of the workflow allowlist — 🟢 impl

*As the owner, I want the assistant to be able to load a skill on any run even though no workflow lists load_skill, so that skills work everywhere without each workflow having to opt in to the tool.*

**Expected behavior.** `load_skill` is the sole ambient tool (tools/mod.rs:147 AMBIENT_TOOLS). `run_descriptors` (mod.rs:162) appends it to the manifest after the workflow's tools when not already present (exactly once, never duplicated; domain tools keep their order with load_skill appended), and `is_allowed` (mod.rs:178) permits it even with an empty allowlist. Both the manifest build and the dispatch gate derive from the same AMBIENT_TOOLS slice, so what the model sees and what Core dispatches cannot drift apart (a test pins this agreement for every ambient tool). The shipped default.toml does NOT list load_skill, so it reaches the model purely via the ambient path.

**Key files:** `crates/core/src/tools/mod.rs:147`, `crates/core/src/tools/mod.rs:155`, `crates/core/src/tools/mod.rs:162`, `crates/core/src/tools/mod.rs:178`

**Existing coverage:** tools/mod.rs unit tests: run_descriptors_appends_ambient_load_skill_once, is_allowed_permits_ambient_and_allowlisted_only, ambient_gate_and_manifest_agree_for_every_ambient_tool. skill-activation.spec.ts proves the ambient path with tools=[] workflow.

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F196 · Agent recognizes a journal-worthy message with entities as one intent graph — 🟢 impl

*As the owner, I want when I write something journal-worthy that also mentions people, projects, or actions, the assistant to propose a single combined card capturing the entry and all entities together, so that I review and accept everything in one decision instead of approving a journal entry and then separate create/link steps across turns.*

**Expected behavior.** The default workflow system_prompt (default.toml:59-117) directs the model: first `search_entities` for each mentioned person/project/todo (querying by short base name), then propose ONE `apply_intent_graph` mutation whose payload is the graph — `journal_entry` node (handle, occurred_at, body of text + entity_ref-target nodes), `entities[]` (>=1, each handle/type/fields and optional `existing_id` hint only on an exact match), and `links[]` (always present, [] if none; todo_project, todo_person with role waiting_on/related, journal_ref per body mention). It must NOT propose create_journal_entry then separate steps; the JE is a node decided together. Activity/aspect qualifiers ('Lead Ads testing', 'the Rodeo side') must be stripped to the project base name so an existing Project is reused, with the qualifier going into prose or a Todo title. A pure-prose entry with nothing to extract is NOT a graph (use create_journal_entry). This is model-facing prompt behavior; the apply path is db/intent_graph.rs.

**Key files:** `crates/core/workflows/default.toml:59`, `crates/core/workflows/default.toml:100`, `crates/core/workflows/default.toml:114`, `crates/core/src/db/intent_graph.rs:1168`

**Existing coverage:** tests/e2e/src/intent-graph-review.spec.ts (accept-all, edit node, reject project standalone, near-twin defaults, create-new override); person/project/todo-extraction.spec.ts; journal-entry-ref.spec.ts

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F197 · Accepting an intent graph resolves reuse-vs-create and applies all nodes atomically — 🟢 impl

*As the owner, I want when I accept (or partially accept) an intent-graph proposal, all the entities, links, and journal entry to be created/reused and linked in one all-or-nothing commit, so that I never get a half-applied capture, and existing entities are reused instead of duplicated.*

**Expected behavior.** `apply_intent_graph_proposal` (db/intent_graph.rs:324) runs one transaction: guarded accept-flip → per-node in-tx disposition → mint creates (people/projects first, todos next with links folded in, journal entry LAST so its body entity_ref placeholders weave to real ids) → resolve the tool call → commit. Disposition per entity node (resolve_disposition, :1106): honor a valid `existing_id` hint of the right type → reuse; else exact (case-insensitive, trimmed) label+type match — zero → create, one → reuse, two-or-more → AMBIGUOUS which FAILS the whole apply as InvalidMutation (no silent fallback) unless an `entity_id` override picks one. Per-node decisions: missing entry = accept; `reject` skips the node and its links/body-refs cascade (a todo_project link to a rejected project drops so the todo lands standalone; a rejected JE ref collapses to plain text, never empty); `edited_fields` corrects a CREATE node (re-validated) but is Invalid on a reuse node; override and edited_fields are mutually exclusive. Reject-all (every node rejected) declines as a non-error and flips the proposal rejected, minting nothing. The anchor returned is the JE id, else the first minted entity. Structural errors (non-object payload, empty entities, unknown type, duplicate handles, bad link endpoints) fail before any tx opens. A reused todo carrying outgoing relationship links fails loud (the graph does not edit an existing todo's links).

**Key files:** `crates/core/src/db/intent_graph.rs:324`, `crates/core/src/db/intent_graph.rs:1106`, `crates/core/src/db/intent_graph.rs:870`, `crates/core/src/db/intent_graph.rs:1168`

**Existing coverage:** Extensive unit tests in intent_graph.rs (plan dispositions, near-match, ambiguous, existing_id hint, weave collapse). tests/e2e/src/intent-graph-review.spec.ts (accept-all lands four linked entities, reject project → standalone todo, edit node sends edited_fields). person/project/todo-extraction.spec.ts.

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F198 · Agent's intent-graph proposal shows create/reuse/ambiguous/near-match badges before I decide — 🟢 impl

*As the owner, I want the review card to tell me, per node, whether it will create a new entity, reuse an existing one, needs disambiguation, or has a near-twin already, so that I can avoid duplicates and disambiguate before committing.*

**Expected behavior.** `resolved_plan_for` (db/intent_graph.rs:159) is a read-only pool query that ships one ResolvedNode per ENTITY node (the JE node is create-only and omitted) so proposal/get can badge the card without re-resolving. Each node mirrors the apply-path's natural disposition exactly: existing_id hint or single exact match → `reuse` (with entity_id); zero → `create` (with advisory `near_matches` — accepted same-type entities whose lowercased whitespace-token set is a subset/superset of this node's name, capped at MAX_NEAR_MATCHES=5, same-type only, omitted when empty); two-or-more → `ambiguous` (with competing candidates). This is advisory display only — resolution is authoritative at decide, which re-resolves in-tx. A structurally malformed graph yields an EMPTY plan (the Client degrades to the raw card) rather than failing the read.

**Key files:** `crates/core/src/db/intent_graph.rs:159`, `crates/core/src/db/intent_graph.rs:251`, `crates/core/src/db/intent_graph.rs:233`, `crates/core/src/db/intent_graph.rs:243`

**Existing coverage:** Unit tests in intent_graph.rs: resolved_plan_omits_je_and_marks_new_entities_create, marks_single_exact_match_reuse, flags_near_match_on_create_node (+subset/cap/cross-type), marks_two_matches_ambiguous_with_candidates, honors_existing_id_hint, malformed_graph_is_empty. tests/e2e/src/intent-graph-review.spec.ts (near-twin defaults to existing, 'Create new instead' override).

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F199 · Agent proposes a journal entry for journal-worthy material in the same thread — 🟢 impl

*As the owner, I want when I share a logged experience, observation, reflection, or event, the assistant to propose creating a journal entry in this same thread, so that my personal record is captured, and same-thread corrections/deletions target the right entry.*

**Expected behavior.** The default workflow system_prompt (default.toml:5-21, 54-57) defines a Journal Entry as a logged experience/observation/reflection/event and instructs the model to propose a create/update/delete journal entry mutation in the SAME original thread when the user shares journal-worthy material. occurred_at must be a local YYYY-MM-DDTHH:MM:SS timestamp and body a non-empty array with at least one text node. For corrections/deletions ('for that entry...', 'delete that one') the model must first call read_current_thread_journal_entries({}) to identify the current thread's accepted entries, and must NOT do cross-thread update/delete. A pure-prose journal-worthy entry with nothing else to extract uses create_journal_entry (not an intent graph). This is model-facing prompt + journal-entry-source provenance behavior (ADR-0030).

**Key files:** `crates/core/workflows/default.toml:5`, `crates/core/workflows/default.toml:15`, `crates/core/workflows/default.toml:54`, `crates/core/src/db/queries.rs:585`

**Existing coverage:** crates/core/tests/proposal_journal_entry_source.rs; proposal_update_journal_entry.rs; proposal_delete_journal_entry.rs; current_thread_journal_entries.rs. direct-capture.spec.ts (journal-worthy row uses PROPOSE worker as contrast).

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F200 · Agent directly captures reminders, projects, and people without a journal entry — 🟢 impl

*As the owner, I want when I state a task, a project to drive, or a person to remember, the assistant to capture it directly (sourced from my message) rather than wrapping it in a journal entry, so that tasks/projects/people are stored as the right GTD entity and not mistaken for journal events.*

**Expected behavior.** The default workflow system_prompt (default.toml:23-52) instructs the model NOT to journal reminders/tasks/obligations and to capture them DIRECTLY, sourced from the user Message (do NOT set payload.source_journal_entry_id): a reminder/task/obligation → create_todo (concise title; status only if asked; note/due_at/defer_at only when explicit); a multi-step driven outcome with a finish line → create_project (NOT for broad buckets like Work/Home/Health or a person's name; if a concrete next action is stated inside it, capture the action as a Todo and don't turn the action phrase into a Project name); a person to remember → create_person (descriptive facts in note; aliases only when explicit). Propose ONE mutation at a time; prefer a single proposal when ambiguous; for ordinary conversation propose nothing. After a direct create_todo is accepted the model may enrich it (search_entities, then update_todo to set project_id / add_person_refs, creating missing person/project first), one mutation per turn, linking only accepted entities.

**Key files:** `crates/core/workflows/default.toml:23`, `crates/core/workflows/default.toml:48`, `crates/core/workflows/default.toml:119`, `crates/core/workflows/default.toml:36`

**Existing coverage:** tests/e2e/src/direct-capture.spec.ts (Todo/Project/Person intent matrix → correct create_* card, Message-sourced entity; journal-worthy contrast). crates/core/tests/proposal_create_todo.rs / _project.rs / _person.rs.

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

#### F201 · Each tool call surfaces a human-readable activity row — 🟢 impl

*As the owner, I want to see a labeled row for each tool the assistant runs (e.g. 'Loaded skill: weekly-review', 'Search entities: Lev'), so that I can follow what the agent is doing in the timeline and on reload.*

**Expected behavior.** Every registered tool has a `label` and a `display_arg` extractor (tools/mod.rs ToolEntry, :117 display_arg dispatcher) so the live `tool_call` Run Event and the `thread/get` rehydration read show the same label (ADR-0043). load_skill → the trimmed skill name (or None for empty/whitespace/missing), search_entities → the trimmed query (None for empty — matches all), read_thread / read_current_thread_journal_entries → no_arg (None). An unregistered tool name returns None rather than panicking. The pending call is persisted before execution so an in-flight row renders, then resolves to completed/error (worker/run.rs:304+). The activity row is rehydrated from run_steps on reload (db MessageSegment::ToolCall, mod.rs:430).

**Key files:** `crates/core/src/tools/mod.rs:117`, `crates/core/src/tools/load_skill.rs:41`, `crates/core/src/tools/search_entities.rs:65`, `crates/core/src/worker/run.rs:304`

**Existing coverage:** tests/e2e/src/skill-activation.spec.ts (asserts 'Loaded skill' label + 'weekly-review' arg, completed status). Unit tests: load_skill display_arg, search_entities display_arg, tools/mod.rs display_arg_dispatches_to_tool_and_none_for_unregistered.

**Phase 2 result:** ✅ pass — Covered by green automated suite (unit/contract/e2e/core all 0 failures, 2026-06-21).

### UI Shell & Theming (critic-found)

#### F202 · toggle-light-dark-theme — ⚪ gap

**Expected behavior.** CRITIC-FOUND GAP (no story written yet): useTheme + theme.ts + the NavShell Sun/Moon button are a fully user-facing surface: clicking the toggle flips document.documentElement.dataset.theme between light/dark, persists the choice to localStorage under 'inkstone-theme', and re-reads it so the theme survives reload. The toggle lives in the shared NavShell (visible on both the chat Sidebar and the Library nav). It drives every theme token across the entire app (sidebar, cards, settings backdrop gradients). None of the 12 areas mention theme, dark mode, useTheme, or the toggle at all.

**Key files:** `/Users/lyuhongy/dev/inkstone/apps/web/src/lib/hooks/useTheme.ts, /Users/lyuhongy/dev/inkstone/apps/web/src/lib/theme.ts, /Users/lyuhongy/dev/inkstone/apps/web/src/components/ui/nav-shell.tsx (lines 33-44, the Toggle theme button)`

**Existing coverage:** none found

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.

#### F203 · collapse-expand-right-rail — ⚪ gap

**Expected behavior.** CRITIC-FOUND GAP (no story written yet): The TopRightControls panel toggle (top-right of the workspace card) collapses/expands the right rail — the recent-runs rail on chat and the activity rail elsewhere. Collapsing animates the grid third track to a 0.5rem sliver and marks the rail aria-hidden + inert (dropped from the a11y tree and tab order); expanding restores it. The control's accessible label flips Open/Close <railLabel>. This is a directly user-triggerable behavior with its own state, and no story covers rail collapse (run-history-activity stories describe the feed contents but never the show/hide toggle).

**Key files:** `/Users/lyuhongy/dev/inkstone/apps/web/src/components/TopRightControls.tsx, /Users/lyuhongy/dev/inkstone/apps/web/src/components/ui/workspace-shell.tsx (toggleRail, gridTemplateColumns sliver logic, aria-hidden/inert rail at lines 105-126)`

**Existing coverage:** none found

**Phase 2 result:** ▢ verify — No automated coverage — pending targeted/audit verification.


---

## Phase 2 — UX / Logistical audit findings & Phase 3 fixes

The automated suites are green, so these are **user-visible defects the passing tests do not assert**, found by a 12-area audit of *live-mounted* code, **adversarially verified** against source (54 raw → 46 confirmed real+live; 8 refuted), then fixed in Phase 3. Companion export: [`audit-findings.csv`](./audit-findings.csv).

**46 confirmed defects** (41 ✅ fixed · 5 ⏸️ deferred) — 2 🔴 high · 22 🟠 medium · 22 🟡 low.

Every fix is gated by the existing test suites; behavior changes are pinned by new/updated tests. Deferred items are feature-additions or need a contract slice / toast subsystem — each carries a recorded reason (not a surgical bug fix).

| ID | Sev | Area | Defect | Status |
|----|-----|------|--------|--------|
| D01 | 🔴 high | Run Control | WebSocket drop mid-stream leaves the assistant bubble stuck "typing" forever with an active, useless Stop button | ✅ fixed |
| D02 | 🔴 high | Run History | Runs feed never updates when a Run finishes — rows stay stuck on "Running"/"Waiting" until the next message is sent | ✅ fixed |
| D03 | 🟠 medium | Chat & Shell | Stopping a run shows a red error-styled "alert" box, framing a deliberate action as a failure | ✅ fixed |
| D04 | 🟠 medium | Chat & Shell | Long unbroken text in a message bubble overflows and is clipped (no word-breaking) | ✅ fixed |
| D05 | 🟠 medium | Global States | Sidebar shows "No threads yet." when Core is down — identical to a genuinely empty workspace | ✅ fixed |
| D06 | 🟠 medium | Global States | Library always shows first-run empty state when Core is down; the authored "Couldn't load" error branch is dead | ✅ fixed |
| D07 | 🟠 medium | Global States | No global error boundary / router errorComponent, and no reconnect banner when the WS drops | ✅ fixed |
| D08 | 🟠 medium | GTD Views | Todos due TODAY are shown as "Overdue" all day (midnight-stored due_at vs to-the-second now) | ✅ fixed |
| D09 | 🟠 medium | GTD Views | Overdue DueChip hides the due date entirely in list rows | ✅ fixed |
| D10 | 🟠 medium | Library / CRUD | Required-field guard on editors has no inline message or a11y association — Save just silently disables | ✅ fixed |
| D11 | 🟠 medium | Library / CRUD | Deleting an entity from Today / Inbox / Waiting / Review yanks the user into a different collection | ✅ fixed |
| D12 | 🟠 medium | Markdown & Copy | Copy button fails silently when clipboard write is rejected | ✅ fixed |
| D13 | 🟠 medium | Proposal Card | Journal-entry edit form gives no hint of the required date-time format until after you type it wrong | ✅ fixed |
| D14 | 🟠 medium | Recurrence / Todo Editor | Completing a recurring todo silently spawns a successor with no UI explanation | ⏸️ deferred |
| D15 | 🟠 medium | Recurrence / Todo Editor | Recurrence end condition (until / after_count) is silently present but never shown or editable | ✅ fixed |
| D16 | 🟠 medium | Run Control | No connection-status surface: the user is never told the app is offline or reconnecting | ✅ fixed |
| D17 | 🟠 medium | Run Control | Stopping a run looks identical to a crash: a deliberate Stop renders a red "error" box | ✅ fixed |
| D18 | 🟠 medium | Run History | Approving or rejecting a proposal does not refresh the Runs feed — a "Waiting" run stays "Waiting" | ✅ fixed |
| D19 | 🟠 medium | Search & Palette | "No matches" flashes during the debounce + network window for message-only queries | ✅ fixed |
| D20 | 🟠 medium | Search & Palette | Message search results are unbounded — a common substring can render thousands of rows | ✅ fixed |
| D21 | 🟠 medium | Search & Palette | onMouseMove hijacks the keyboard-selected row, fighting arrow-key navigation | ✅ fixed |
| D22 | 🟠 medium | Settings & Providers | Every settings save failure is swallowed silently — the user is told nothing and the UI silently reverts | ✅ fixed |
| D23 | 🟠 medium | Settings & Providers | Connect button reports success the instant a tab opens — no 'connecting' / completion / failure feedback after that | ✅ fixed |
| D24 | 🟠 medium | Threads & Nav | Thread-list fetch error is silently rendered as "No threads yet" | ✅ fixed |
| D25 | 🟡 low | Chat & Shell | Send-failure error banner persists when switching threads | ✅ fixed |
| D26 | 🟡 low | Chat & Shell | Sidebar shows "No threads yet" even when the thread list failed to load | ✅ fixed |
| D27 | 🟡 low | Chat & Shell | Composer textarea never grows; multi-line input is hidden in a single visible row | ✅ fixed |
| D28 | 🟡 low | GTD Views | Review header count disagrees with the sidebar "Review" badge mid-session | ✅ fixed |
| D29 | 🟡 low | Library / CRUD | No success feedback after any create, edit, or delete | ⏸️ deferred |
| D30 | 🟡 low | Markdown & Copy | Copy success is conveyed only by an icon swap; screen readers get no confirmation | ✅ fixed |
| D31 | 🟡 low | Markdown & Copy | Wide markdown tables in assistant replies have no horizontal scroll wrapper and can overflow the chat column | ✅ fixed |
| D32 | 🟡 low | Proposal Card | update_todo approval shows a raw UUID and no 'Current' values — unlike every other update kind | ✅ fixed |
| D33 | 🟡 low | Proposal Card | Ambiguous intent-graph node never shows WHAT it matched — only a dead-end 'Needs disambiguation' badge | ⏸️ deferred |
| D34 | 🟡 low | Recurrence / Todo Editor | Recurrence summary omits the anchor, so the user can't verify which date drives the repeat without opening the editor | ✅ fixed |
| D35 | 🟡 low | Recurrence / Todo Editor | 'Anchor' recurrence field is unexplained jargon | ✅ fixed |
| D36 | 🟡 low | Recurrence / Todo Editor | Todo editor can only set a 'waiting on' person; existing 'related' person refs are invisible and silently preserved | ⏸️ deferred |
| D37 | 🟡 low | Run Control | A run that errors with no message shows a generic "stopped" notice that mislabels a failure as a user stop | ✅ fixed |
| D38 | 🟡 low | Run History | "Older" runs show only month/day with no year — last year's run is indistinguishable from this year's | ✅ fixed |
| D39 | 🟡 low | Search & Palette | Active index is not re-clamped when results change asynchronously, so Enter can silently no-op | ✅ fixed |
| D40 | 🟡 low | Search & Palette | No loading / latency feedback while message search runs | ✅ fixed |
| D41 | 🟡 low | Search & Palette | Matched search term is not highlighted in message snippets or any result row | ⏸️ deferred |
| D42 | 🟡 low | Settings & Providers | 'Set as preferred' action is invisible until hover and unreachable by touch / hard to discover | ✅ fixed |
| D43 | 🟡 low | Settings & Providers | Composer EffortPicker shows 'Off' before settings load, mislabeling the real effort | ✅ fixed |
| D44 | 🟡 low | Settings & Providers | No save confirmation on success — a settings change gives no acknowledgement | ✅ fixed |
| D45 | 🟡 low | Threads & Nav | Copy-thread-id button gives no visible confirmation that anything was copied | ✅ fixed |
| D46 | 🟡 low | Threads & Nav | Long thread titles truncate with no tooltip or full-text reveal | ✅ fixed |

### Deferred — with reasons

- **D14 · Completing a recurring todo silently spawns a successor with no UI explanation** (🟠 medium) — Server-authoritative: only Core knows if a successor was actually spawned (an after_count series ending spawns none). A client-side guess would lie. Clean fix = contract slice adding a spawned-successor signal to EntityMutateResult through the parity gate.

- **D29 · No success feedback after any create, edit, or delete** (🟡 low) — Needs a shared toast/notification surface the app lacks; building one is a subsystem (§2 simplicity). Edit/create already give implicit feedback (rail returns showing updated values + list refreshes).

- **D33 · Ambiguous intent-graph node never shows WHAT it matched — only a dead-end 'Needs disambiguation' badge** (🟡 low) — Tracked as feature #181 (the disambiguation picker). The advisory near-match plumbing exists; surfacing the competing candidates is a new UI affordance, not a bug fix.

- **D36 · Todo editor can only set a 'waiting on' person; existing 'related' person refs are invisible and silently preserved** (🟡 low) — Feature addition: a second person-ref role editor (related). Existing 'related' refs round-trip untouched; this adds new editing capability, not a bug fix.

- **D41 · Matched search term is not highlighted in message snippets or any result row** (🟡 low) — Enhancement: snippet term highlighting. Current snippet already excerpts around the match (Core sends ±pad); emphasis is polish, deferred.

### Fixed — detail

#### D01 · 🔴 high · WebSocket drop mid-stream leaves the assistant bubble stuck "typing" forever with an active, useless Stop button

- **User impact:** If the WS connection drops while a reply is streaming (laptop sleeps, Core restarts, network blip), the assistant bubble keeps showing the animated typing indicator indefinitely and the composer keeps showing the Stop (Square) button as if the run were live. The user has no signal that anything went wrong, cannot send a new message (Enter is swallowed while isRunning), and clicking Stop does nothing useful. The run never resolves to an error/retry state.
- **Fix:** In `startRunStream`, add a failure handler on the stream program (e.g. `.pipe(Effect.catchAll(() => Effect.sync(() => applyEvent(threadId, runId, { kind: "error", message: "Lost connection before this reply finished. Try again." }))))`) so a dropped/failed subscribe settles the bubble to `incomplete`, clears `activeRunId`, and frees Stop. Even better, drive a reconnect-and-resubscribe, but at minimum the bubble must leave the streaming state on stream failure.
- **Files:** `apps/web/src/store/bridge.ts`, `apps/web/src/store/chat.ts`, `apps/web/src/components/ChatColumn.tsx`, `packages/ui-sdk/src/index.ts`

#### D02 · 🔴 high · Runs feed never updates when a Run finishes — rows stay stuck on "Running"/"Waiting" until the next message is sent

- **User impact:** A user starts a chat; the right-rail Runs feed shows the run as "Running" (spinner). The agent finishes seconds later — the chat bubble completes, but the feed row keeps showing "Running" indefinitely. It only flips to "Done"/"Failed" the next time the user sends a message, retries, or reloads. The feed silently lies about live state, which is the whole point of a recency feed.
- **Fix:** In store/chat.ts settleTerminal (or wherever the terminal run event is observed at the React boundary), invalidate the ["run-history"] query when a run reaches a terminal kind. Simplest: have the stream consumer that drives applyEvent also call queryClient.invalidateQueries({queryKey:["run-history"]}) on terminal events, mirroring the send/retry paths.
- **Files:** `apps/web/src/lib/hooks/useRunHistory.ts`, `apps/web/src/components/ChatColumn.tsx`, `apps/web/src/store/chat.ts`, `apps/web/src/main.tsx`

#### D03 · 🟠 medium · Stopping a run shows a red error-styled "alert" box, framing a deliberate action as a failure

- **User impact:** When the user clicks the Stop (Square) button to cancel a streaming reply — a normal, intentional action — the assistant turn renders inside a red destructive-bordered box reading "This reply stopped before it finished. Nothing was saved without your approval." with a "Try again" button. Visually and to screen readers (role="alert") this is identical to a genuine model/transport error, so a user who intentionally stopped is told something went wrong.
- **Fix:** Distinguish cancellation from failure: carry a flag (e.g. `cancelled: true`) on the cancelled-settled message and render it in a calm/muted style ("Stopped.") rather than the destructive alert box, reserving the red `role="alert"` treatment for the `error` branch.
- **Files:** `apps/web/src/components/ChatColumn.tsx`, `apps/web/src/store/chat.ts`

#### D04 · 🟠 medium · Long unbroken text in a message bubble overflows and is clipped (no word-breaking)

- **User impact:** A user message (or assistant reply) containing a long unbroken token — a pasted URL, file path, hash, or long string with no spaces — overflows its bubble. The chat scroller is vertical-only and the surface is `overflow-hidden`, so the overflowing text is clipped and partially invisible rather than wrapping; the user can never see the full content.
- **Fix:** Add `break-words` (overflow-wrap: anywhere) to the user bubble inner div and the assistant prose container so unbreakable tokens wrap inside the bubble instead of overflowing the clipped surface.
- **Files:** `apps/web/src/components/ChatColumn.tsx`

#### D05 · 🟠 medium · Sidebar shows "No threads yet." when Core is down — identical to a genuinely empty workspace

- **User impact:** A returning user who has many threads, but whose Core/WS is down (process not running, or connection dropped after 5 failed reconnects), opens the app and sees the sidebar say "No threads yet." — exactly the same as a brand-new empty account. Their entire conversation history appears to have silently vanished, with no error, no retry, and no hint that the data merely failed to load. Alarming for a local-first app whose promise is "your data is safe on disk."
- **Fix:** Destructure `isError` (and `isPending`) from useThreads in Sidebar.tsx and add an error branch distinct from the empty branch (mirror RunFeed's FeedError: a calm "Couldn't load your threads" line + Try again calling `refetch`), so Core-down looks different from a truly empty workspace.
- **Files:** `apps/web/src/components/Sidebar.tsx`, `apps/web/src/lib/hooks/useThreads.ts`, `apps/web/src/components/RunFeed.tsx`

#### D06 · 🟠 medium · Library always shows first-run empty state when Core is down; the authored "Couldn't load" error branch is dead

- **User impact:** When Core/WS is unreachable, opening any Library collection shows the friendly first-run empty state (e.g. "No journal entries yet — Use New … to add one, or accept a proposal suggested from chats.") instead of an error. A user with a populated Library sees it appear empty, with a 0 count badge, and is even invited to start adding items — with zero indication the data failed to load.
- **Fix:** Let useLibraryItems reject on Core-unreachable (remove the catch-to-[] or gate it to a preview-only flag) so the query's `isError` becomes true and the already-written EntityCollection error branch renders. Keep strict per-row validation as a separate guard that does not mask the connection failure.
- **Files:** `apps/web/src/lib/hooks/useLibraryItems.ts`, `apps/web/src/components/library/EntityCollection.tsx`

#### D07 · 🟠 medium · No global error boundary / router errorComponent, and no reconnect banner when the WS drops

- **User impact:** Two related gaps. (1) If any component throws during render the user falls back to TanStack Router's bare built-in error UI — no Inkstone chrome, no styling, no friendly reload affordance — and an error thrown outside the router boundary (provider init / main.tsx) white-screens entirely. (2) When the live WS connection drops and the SDK exhausts its 5 bounded reconnect retries, nothing tells the user the app is now offline; they discover it only one failed action at a time.
- **Fix:** Add `defaultErrorComponent` (and `defaultNotFoundComponent`) to createRouter in main.tsx rendering a styled EmptyState (tone="danger") with a Reload action so render crashes stay in the app's look-and-feel. Separately, surface a lightweight global aria-live "Connection lost — reconnecting…" / "Couldn't reach Inkstone" banner driven off the SDK connection lifecycle once reconnect retries are exhausted.
- **Files:** `apps/web/src/main.tsx`, `apps/web/src/runtime.tsx`, `packages/ui-sdk/src/index.ts`

#### D08 · 🟠 medium · Todos due TODAY are shown as "Overdue" all day (midnight-stored due_at vs to-the-second now)

- **User impact:** Every todo the user sets a due date on via the editor is stored at midnight of that day. From the moment past midnight until 23:59 of its due day, the todo is flagged with the red "Overdue" badge in the Today "Due soon" list, the Waiting list, and the todo detail panel — even though it is due today and not actually late. A user who set something due "today" sees a scary red Overdue chip in the morning, which is wrong and erodes trust in the views.
- **Fix:** Make overdue a to-the-day comparison consistent with how due dates are stored and how `dueSoonTodos` already works: in `todoIsOverdue` compare `todo.dueAt.slice(0,10) < now.slice(0,10)` (or normalize the stored due_at to end-of-day). Then a todo due today is "due today", and only a strictly-earlier day reads "Overdue". Optionally add a distinct "Due today" chip state.
- **Files:** `apps/web/src/lib/libraryItems.ts`, `apps/web/src/lib/entityCodec.ts`, `apps/web/src/components/library/EntityRow.tsx`, `apps/web/src/components/library/EntityDetail.tsx`

#### D09 · 🟠 medium · Overdue DueChip hides the due date entirely in list rows

- **User impact:** In the Today "Due soon" list and any todo list row, an overdue todo's chip renders only the word "Overdue" and drops the date. When several todos are overdue they all show an identical "Overdue" pill with no date, so the user cannot tell whether something is 1 day or 3 weeks overdue, and the row subtitle shows only the project name — the due date is nowhere on the row.
- **Fix:** Show the date alongside the overdue marker, e.g. `Overdue · {due}` (matching the detail panel's `Overdue · ` format at EntityDetail.tsx:867), so overdue rows remain distinguishable and dated.
- **Files:** `apps/web/src/components/library/EntityRow.tsx`, `apps/web/src/components/library/TodayOverview.tsx`

#### D10 · 🟠 medium · Required-field guard on editors has no inline message or a11y association — Save just silently disables

- **User impact:** In New/Edit Person, Project, Bookmark, Todo and Journal Entry, clearing the required field (Name / Title / Body / Occurred-at) disables the Save button at 50% opacity with no visible reason and nothing announced to assistive tech. A keyboard or screen-reader user cannot tell which field is required or why Save won't work; the field carries no required/aria-required marker and the disabled Save has no aria-describedby pointing at an explanation.
- **Fix:** Mark the required input with aria-required and (when empty) aria-invalid, and render a short hint (e.g. "Add a name to save") with an id wired to the input via aria-describedby — mirroring the recurrence-hint pattern already in TodoEditor. This makes the disabled-Save reason visible and announced.
- **Files:** `apps/web/src/components/library/EntityEditor.tsx`, `apps/web/src/components/library/PersonEditor.tsx`, `apps/web/src/components/library/ProjectEditor.tsx`, `apps/web/src/components/library/BookmarkEditor.tsx`, `apps/web/src/components/library/JournalEntryEditor.tsx`

#### D11 · 🟠 medium · Deleting an entity from Today / Inbox / Waiting / Review yanks the user into a different collection

- **User impact:** A user viewing a Todo's detail from the Inbox (or Waiting), or a Project from Today / Review, and clicking Delete is silently navigated OUT of the view they were in and dropped onto the kind's full collection page (e.g. delete a Todo from Inbox → land on /library/todos). They lose their place and their filtered context with no indication why the page changed.
- **Fix:** On delete success, stay on the current route and only drop ?id. Instead of navigating to the kind's collection, navigate to the current pathname with search:{} (e.g. use the router's current location, or pass a route-supplied onDeleted/closeDetail callback down to InspectorShell the way route.tsx already passes closeCreate/openCreated to the create editor), so the rail returns to empty without changing collections.
- **Files:** `apps/web/src/components/library/EntityDetail.tsx`, `apps/web/src/routes/library/route.tsx`, `apps/web/src/routes/library/inbox.tsx`, `apps/web/src/routes/library/index.tsx`, `apps/web/src/routes/library/review.tsx`

#### D12 · 🟠 medium · Copy button fails silently when clipboard write is rejected

- **User impact:** If the Clipboard API rejects (permission denied, document not focused, non-secure context / http origin, or a browser without navigator.clipboard), clicking Copy does nothing the user can see: the icon never changes to the check, no error appears, and the user believes the reply was copied when it was not. They paste stale/empty content elsewhere.
- **Fix:** Wrap the writeText in try/catch inside `copy`; on failure surface a visible error state (e.g. return/expose an `error` flag the button can render, or fall back to a toast). At minimum, attach a `.catch` in CopyButton so the rejection is handled and the user is told copy failed.
- **Files:** `apps/web/src/lib/hooks/useCopyToClipboard.ts`, `apps/web/src/components/CopyButton.tsx`

#### D13 · 🟠 medium · Journal-entry edit form gives no hint of the required date-time format until after you type it wrong

- **User impact:** Editing a proposed Journal Entry exposes 'Occurred at' and 'Ended at' as bare text boxes. There is no placeholder, no example, and no inline hint that the value must be `YYYY-MM-DDTHH:MM:SS`. The user only discovers the required shape after typing something natural (e.g. 'June 21 3pm'), which silently disables Save and then surfaces the alert 'Edit required fields: occurred at must use YYYY-MM-DDTHH:MM:SS.' On the approval surface this turns a simple time correction into trial-and-error.
- **Fix:** Pass placeholder="YYYY-MM-DDTHH:MM:SS" (or a concrete example like 2026-06-21T15:00:00) to the Occurred at / Ended at EditorInputs, or add a small muted hint line under the labels, so the format is visible before the user types.
- **Files:** `apps/web/src/components/ProposalCard.tsx`, `apps/web/src/components/library/EntityEditor.tsx`

#### D15 · 🟠 medium · Recurrence end condition (until / after_count) is silently present but never shown or editable

- **User impact:** A recurring todo created elsewhere (e.g. by the chat/AI agent) can carry an end condition: 'repeats weekly until 2026-12-31' or 'repeats daily for 5 times'. In the Library the user sees only the badge 'Repeats weekly' and an editor with Every/Unit/Anchor. The end condition is completely hidden: it is not displayed in the inspector, not shown in the editor, and there is no control to view, change, or remove it. The user cannot tell the repeat will ever stop, and cannot edit when it stops.
- **Fix:** At minimum, append the end condition to `recurrenceSummary` (e.g. 'Repeats weekly until Dec 31, 2026' / 'Repeats daily, 5 times') so the user can see it. Ideally add a read/edit control in TodoEditor for the end condition instead of only stashing it.
- **Files:** `apps/web/src/components/library/TodoEditor.tsx`, `apps/web/src/lib/entityCodec.ts`, `apps/web/src/lib/libraryItems.ts`, `apps/web/src/components/library/EntityDetail.tsx`

#### D16 · 🟠 medium · No connection-status surface: the user is never told the app is offline or reconnecting

- **User impact:** There is no global indicator that the WebSocket has dropped, is retrying, or has permanently failed. During the retry window (up to 5 exponential-backoff attempts) and after it gives up, the user sees a normal-looking UI; sends silently block on the writer latch (waiting for a connection that may never come) or fail with a generic "Couldn't send your message. Please try again." with no hint that the underlying cause is a lost connection.
- **Fix:** Expose a connection-status signal from the SDK layer (connected / reconnecting / disconnected) and render a small global banner or toast (e.g. "Reconnecting…" / "Lost connection to Inkstone"). Wire send failures whose cause is `connection_lost` to a connection-specific message rather than the generic retry copy.
- **Files:** `apps/web/src/store/bridge.ts`, `apps/web/src/components/ChatColumn.tsx`, `packages/ui-sdk/src/index.ts`, `apps/web/src/runtime.tsx`

#### D17 · 🟠 medium · Stopping a run looks identical to a crash: a deliberate Stop renders a red "error" box

- **User impact:** When the user clicks Stop, the cancelled turn is rendered in the same red, destructive-bordered "assistant-error" alert box used for genuine worker/provider failures, with the copy "This reply stopped before it finished. Nothing was saved without your approval." A user who intentionally stopped a run sees what looks like an error state (red border, red text, alert role), which reads as "something broke" rather than "you stopped this."
- **Fix:** Distinguish a user-cancelled turn from a failure. E.g. give cancelled messages a neutral/muted style (not destructive red, not role=alert) and copy like "You stopped this reply.", while keeping the red error box only for `error` events that carry a real `message`. This needs a way to tell the two `incomplete` causes apart (e.g. a `cancelled` flag on the message, or a sentinel).
- **Files:** `apps/web/src/components/ChatColumn.tsx`, `apps/web/src/store/chat.ts`, `apps/web/src/store/bridge.ts`

#### D18 · 🟠 medium · Approving or rejecting a proposal does not refresh the Runs feed — a "Waiting" run stays "Waiting"

- **User impact:** A run is parked awaiting a decision and shows "Waiting" in the feed. The user clicks Approve/Reject on the proposal card. The run resumes (kind becomes proposal_decided → "Running, resumed", then eventually done/error), but the feed row keeps showing "Waiting" because nothing re-reads run history after the decision. The user sees a stale, contradictory status right after taking the action that changed it.
- **Fix:** In AssistantProposals.tsx onDecide, also invalidate ["run-history"] (and ["threads"]) after decideProposal resolves, for all decisions including reject, since every decision advances the run's milestone.
- **Files:** `apps/web/src/components/AssistantProposals.tsx`, `apps/web/src/lib/runHistory.ts`, `packages/protocol/src/index.ts`

#### D19 · 🟠 medium · "No matches" flashes during the debounce + network window for message-only queries

- **User impact:** After the user finishes typing a query that only matches message text (e.g. a word that appears inside a chat but is not a thread title or library item name), the palette shows "No matches for \"…\"" for ~180ms plus the server round-trip, then the real results pop in. The user is told their search failed a fraction of a second before it succeeds — a jarring false-negative that invites them to give up or re-type.
- **Fix:** Gate the no-results paragraph on the search actually being settled: derive isFetching from useMessageSearch and, when the trimmed query differs from debouncedQuery OR the message query is fetching, render a quiet "Searching…" state (or keep the previous results) instead of "No matches". Simplest: only show "No matches" when query.trim() === debouncedQuery.trim() and the message query is not pending.
- **Files:** `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/lib/hooks/useMessageSearch.ts`

#### D20 · 🟠 medium · Message search results are unbounded — a common substring can render thousands of rows

- **User impact:** Typing a very common word (e.g. "the", "a", "and") returns every message in the entire database that contains it. The threads group is capped at 5 and library at 8, but the Messages group renders every hit with no cap, producing an enormous scroll list, a sluggish/janky palette, and an active-index range in the thousands for arrow navigation.
- **Fix:** Add a LIMIT (e.g. 20-50) to the search_messages SQL in queries.rs, and/or .slice the hits in CommandPalette.tsx:100 to a small cap consistent with the other groups.
- **Files:** `crates/core/src/db/queries.rs`, `apps/web/src/components/CommandPalette.tsx`

#### D21 · 🟠 medium · onMouseMove hijacks the keyboard-selected row, fighting arrow-key navigation

- **User impact:** Each result row sets the active selection on every mouse-move (not mouse-enter). If the cursor is resting anywhere over the result list while the user navigates with arrow keys, the active highlight jumps back to whatever row is under the pointer — including when the list auto-scrolls under a stationary cursor (the scrollIntoView on arrow-nav moves rows beneath the pointer, which fires mousemove). The result is the selection visibly snapping away from where the keyboard put it, and Enter activating the wrong row.
- **Fix:** Switch row pointer tracking from onMouseMove to onMouseEnter (or guard setActive so a mousemove only updates active when the pointer position actually changed, ignoring scroll-induced events) so keyboard navigation isn't clobbered by an idle cursor.
- **Files:** `apps/web/src/components/CommandPalette.tsx`

#### D22 · 🟠 medium · Every settings save failure is swallowed silently — the user is told nothing and the UI silently reverts

- **User impact:** If saving the preferred model or effort fails (backend down, write error, network blip), the optimistic UI flips to the new value and then — because the failed promise only runs `.catch(() => {})` and never re-reads — the UI keeps showing the value the user picked even though nothing was persisted. The user believes their preference was saved when it was not. There is no toast, inline error, or any feedback anywhere in the app (no toast/Toaster/sonner infrastructure exists at all).
- **Fix:** On the `.catch`, revert the optimistic state to the last-known-good value and surface a visible error (a small inline message or a toast). Minimal version: capture the prior value before the optimistic set and restore it in the catch so the on-screen state never lies about what is persisted.
- **Files:** `apps/web/src/routes/settings/models.tsx`, `apps/web/src/components/ModelPicker.tsx`, `apps/web/src/components/EffortPicker.tsx`

#### D23 · 🟠 medium · Connect button reports success the instant a tab opens — no 'connecting' / completion / failure feedback after that

- **User impact:** Clicking Connect shows 'busy' only while the authorize URL is fetched, then opens a new tab and immediately clears busy. The user is left on the Settings page with the card still showing 'Not connected' and a re-enabled Connect button while the OAuth flow happens in another tab. There is no 'Connecting…' / 'Waiting for login…' state, no spinner, and no error if login fails. The card only updates to 'Connected' if/when the user returns focus to this tab (the window 'focus' listener re-queries). If they never refocus, or focus the tab before completing login, the status stays stale and stuck on 'Not connected'. If `startLogin` itself fails (can't fetch authorize URL), the error is swallowed by `.catch(() => {})` and the user sees nothing — the button just snaps back to enabled with no explanation.
- **Fix:** After opening the tab, show a persistent 'Waiting for login… (return here when done)' state and surface an error if `startLogin` rejects (replace the empty catch). Optionally poll `provider/status` while waiting instead of relying solely on the window focus event, so the card updates even if the user never blurs/refocuses this tab.
- **Files:** `apps/web/src/routes/settings/models.tsx`, `apps/web/src/store/providers.ts`, `apps/web/src/components/ProviderConnectionCard.tsx`

#### D24 · 🟠 medium · Thread-list fetch error is silently rendered as "No threads yet"

- **User impact:** If `thread/list` fails (transient WS error, Core not ready), the Sidebar shows the exact same "No threads yet." copy as a genuinely empty account. A returning user with real threads sees an empty sidebar that falsely claims they have no conversations, with no error indication and no retry. They cannot distinguish "load failed" from "truly empty" and have no affordance to recover other than a full reload.
- **Fix:** Read `isError`/`isLoading` from useThreads and branch: while loading show a skeleton or nothing rather than the empty-copy, and on error show a short "Couldn't load conversations — Try again" row that calls `refetch()`.
- **Files:** `apps/web/src/components/Sidebar.tsx`, `apps/web/src/lib/hooks/useThreads.ts`

#### D25 · 🟡 low · Send-failure error banner persists when switching threads

- **User impact:** After a failed send shows "Couldn't send your message. Please try again.", clicking a different thread in the sidebar navigates to that thread but the stale error banner remains visible above its composer, implying the new (untouched) thread also has a problem.
- **Fix:** Clear the error on focus change: add `useEffect(() => setSendError(null), [focusedThreadId])` (and similarly reset on successful navigation to a new thread).
- **Files:** `apps/web/src/components/ChatColumn.tsx`, `apps/web/src/routes/_chat.tsx`

#### D26 · 🟡 low · Sidebar shows "No threads yet" even when the thread list failed to load

- **User impact:** If Core is unreachable or `thread/list` errors, the sidebar silently renders the same "No threads yet." empty state a brand-new user sees. A returning user with existing threads is told they have none, with no indication it was a load failure or any way to retry.
- **Fix:** Read `isError` from `useThreads()` and render a distinct calm error state with a retry (mirroring RunFeed's FeedError) instead of the empty-state copy.
- **Files:** `apps/web/src/components/Sidebar.tsx`, `apps/web/src/lib/hooks/useThreads.ts`

#### D27 · 🟡 low · Composer textarea never grows; multi-line input is hidden in a single visible row

- **User impact:** The message composer is fixed at one visible line. When a user composes a multi-line message (Shift+Enter) or pastes several lines, earlier lines scroll out of view inside the one-row textarea, so they can't see what they typed before sending.
- **Fix:** Let the textarea grow to fit content up to a max height: add `field-sizing: content` (with a `max-height` + `overflow-y-auto`) or an onInput auto-resize that sets height from scrollHeight.
- **Files:** `apps/web/src/components/ComposeFooter.tsx`, `apps/web/src/index.css`

#### D28 · 🟡 low · Review header count disagrees with the sidebar "Review" badge mid-session

- **User impact:** The Review page header count is frozen to the session snapshot (e.g. "Review 3") and does not change as you mark projects reviewed, while the left-nav "Review" badge uses the live count and ticks down (e.g. to "1"). During a review session the two numbers visibly disagree, which can read as a bug to the user even though the queue freeze is intentional.
- **Fix:** Either label the header count as remaining (live count of not-yet-reviewed projects in the queue) or show "reviewed/total" so the header reconciles with the sidebar badge; alternatively keep both as live counts.
- **Files:** `apps/web/src/components/library/ProjectReviewView.tsx`, `apps/web/src/components/library/LibraryNav.tsx`

#### D30 · 🟡 low · Copy success is conveyed only by an icon swap; screen readers get no confirmation

- **User impact:** After a successful copy, a sighted user sees the Copy icon briefly become a checkmark, but a screen-reader user hears nothing: the button's accessible name stays "Copy" the whole time and there is no live-region announcement. There is also no visible 'Copied' text or tooltip/title, so the affordance relies entirely on a 14px icon change that disappears after 2s.
- **Fix:** Update the accessible name when copied (e.g. `aria-label={copied ? "Copied" : "Copy"}`) and/or render a visually-hidden `role="status"`/`aria-live="polite"` span that says "Copied" while `copied` is true. A `title` attribute would also give a hover tooltip for the icon-only button.
- **Files:** `apps/web/src/components/CopyButton.tsx`, `apps/web/src/components/ui/button.tsx`

#### D31 · 🟡 low · Wide markdown tables in assistant replies have no horizontal scroll wrapper and can overflow the chat column

- **User impact:** GFM tables render (remark-gfm is enabled), and code blocks scroll because the typography plugin gives `pre` overflow-x:auto. But a table with many/wide columns has no scroll container, and the message wrapper uses `max-w-none`. A wide table can stretch the assistant message wider than intended or get clipped, since ChatMarkdown emits a bare `<table>` with no surrounding `overflow-x:auto` div.
- **Fix:** Add a `table` component override in ChatMarkdown that wraps the table in `<div className="overflow-x-auto">`, or add `.prose :where(table) { display:block; overflow-x:auto; }` plus `overflow-wrap:anywhere` on the prose container so long tables/URLs cannot blow out the column width.
- **Files:** `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/components/ChatColumn.tsx`, `apps/web/src/index.css`

#### D32 · 🟡 low · update_todo approval shows a raw UUID and no 'Current' values — unlike every other update kind

- **User impact:** When approving a Todo update, the card shows 'Update Todo' as the title and a 'Changes' block whose first row is `Todo: 7f3a9c2e-…` (a raw UUID) plus only the changed fields. There is no 'Current' section showing the Todo's existing title/note/status, so the user cannot see what they are changing FROM, and cannot even tell which Todo this is by name. Person, Project, and Journal-Entry updates all render a Current-vs-Proposed (or Replacing-with) diff; Todo is the one update kind that does not, which is exactly the surface where the user is being asked to approve a mutation blind.
- **Fix:** At minimum, resolve and display the Todo's name instead of the raw UUID (the warm library-items cache used by DecidedLibraryLink already maps id→title), so the header/diff reads 'Update Todo: «Backfill contacts»'. Ideally add a current_todo to ProposalReviewContext and render a Current-vs-Changes diff to match the other update kinds.
- **Files:** `apps/web/src/components/ProposalCard.tsx`, `packages/protocol/src/index.ts`

#### D34 · 🟡 low · Recurrence summary omits the anchor, so the user can't verify which date drives the repeat without opening the editor

- **User impact:** The inspector badge says only 'Repeats weekly' but the rule actually repeats relative to either the defer date or the due date (a meaningful difference the editor forces the user to choose). Because the summary drops the anchor, two todos that behave differently look identical, and the user must open the editor to discover which date the schedule keys off.
- **Fix:** Include the anchor in the summary when it differs from the obvious case, e.g. 'Repeats weekly (from due date)'.
- **Files:** `apps/web/src/lib/libraryItems.ts`, `apps/web/src/components/library/EntityDetail.tsx`

#### D35 · 🟡 low · 'Anchor' recurrence field is unexplained jargon

- **User impact:** When a user turns on Repeats, the editor shows an 'Anchor' dropdown with options 'Defer date' / 'Due date'. There is no helper text explaining what an anchor is or that it determines which date the next occurrence is computed from. A non-technical user has no way to understand the choice; 'Anchor' is internal terminology, not task-management language.
- **Fix:** Relabel to something like 'Repeat from' and add a short hint ('Each completion schedules the next from this date'), or phrase the options as 'From the due date' / 'From the defer date'.
- **Files:** `apps/web/src/components/library/TodoEditor.tsx`

#### D37 · 🟡 low · A run that errors with no message shows a generic "stopped" notice that mislabels a failure as a user stop

- **User impact:** When a run terminates with an `error` event whose `message` is empty/absent, the bubble falls back to "This reply stopped before it finished. Nothing was saved without your approval." — wording that implies the USER stopped it. A real failure (worker crash, provider error with no text) is thus presented to the user as if it were a deliberate stop, hiding that an error occurred.
- **Fix:** Give the error path its own fallback when `message.error` is empty (e.g. "Something went wrong generating this reply. Try again.") distinct from the cancel copy, and treat an empty-string error message the same as a missing one (guard on `message.error?.trim()` rather than `??`).
- **Files:** `apps/web/src/components/ChatColumn.tsx`, `apps/web/src/store/chat.ts`

#### D38 · 🟡 low · "Older" runs show only month/day with no year — last year's run is indistinguishable from this year's

- **User impact:** A run from a previous calendar year lands in the "Older" bucket and its timestamp renders as e.g. "Mar 5" with no year. The user cannot tell whether it happened months ago or over a year ago, and two runs a year apart look identical.
- **Fix:** In formatRunTime, include the year when the run's year differs from the current year (e.g. add `year: "numeric"` conditionally when new Date(at).getFullYear() !== new Date(now).getFullYear()).
- **Files:** `apps/web/src/lib/runHistory.ts`

#### D39 · 🟡 low · Active index is not re-clamped when results change asynchronously, so Enter can silently no-op

- **User impact:** If the user arrow-keys down toward the bottom of the currently-rendered results and the result set then shrinks from async data settling (lazy thread fetch completing differently, or the debounced message search returning fewer/zero hits than the previous query), the active index can point past the end of the list. No row appears selected and pressing Enter does nothing — the palette feels dead even though it is open with results.
- **Fix:** Add an effect that clamps active into range whenever flat changes, e.g. `useEffect(() => setActive(a => Math.min(a, Math.max(flat.length - 1, 0))), [flat.length])`.
- **Files:** `apps/web/src/components/CommandPalette.tsx`

#### D40 · 🟡 low · No loading / latency feedback while message search runs

- **User impact:** The command palette never shows any spinner, skeleton, or "Searching…" indicator while the server-side message full-text search is in flight. On a large local database (and message search has no result cap — see separate finding) the user sees a static, seemingly-empty or stale list with no sign that work is happening, so a slow search reads as a frozen/broken palette.
- **Fix:** Consume isFetching from useMessageSearch and render a lightweight inline indicator (e.g. a small spinner next to the "Messages" group header, or a thin top progress bar in the dialog) while the debounced query is being fetched.
- **Files:** `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/lib/hooks/useMessageSearch.ts`

#### D42 · 🟡 low · 'Set as preferred' action is invisible until hover and unreachable by touch / hard to discover

- **User impact:** In the model catalog table, every non-preferred row's 'Set as preferred' button is rendered with `opacity-0` and only revealed on row hover (`group-hover/row:opacity-100`) or keyboard focus (`focus-visible:opacity-100`). On a touch device (no hover) the button is fully transparent yet still occupies layout — a user cannot see there is any way to change the preferred model. Even on desktop, the only way to discover you can change models is to hover each row. There is no persistent affordance indicating rows are actionable.
- **Fix:** Keep the action faintly visible at rest (e.g. opacity-60) and brighten on hover/focus, or make the whole row clickable to set-as-preferred, so the affordance is discoverable on touch and without hover.
- **Files:** `apps/web/src/components/ModelCatalogTable.tsx`

#### D43 · 🟡 low · Composer EffortPicker shows 'Off' before settings load, mislabeling the real effort

- **User impact:** The composer effort chip initializes to `effort = 'off'` and displays the label 'Off' immediately on mount, before `settings/get` resolves. If the user's real saved effort is e.g. 'High', the chip briefly (or, if the fetch fails, permanently) reads 'Off' — telling the user their model won't reason when it actually will. The ModelPicker handles this more honestly with a 'Select model' placeholder, but the effort chip presents a concrete-but-wrong value.
- **Fix:** Initialize effort to `null`/undefined and render the neutral 'Effort' label until `settings/get` resolves, mirroring the ModelPicker's 'Select model' placeholder, so the chip never claims a concrete value it hasn't confirmed.
- **Files:** `apps/web/src/components/EffortPicker.tsx`, `apps/web/src/routes/settings/models.tsx`

#### D44 · 🟡 low · No save confirmation on success — a settings change gives no acknowledgement

- **User impact:** When a user picks an effort level or sets a preferred model in Settings, the only feedback is the optimistic highlight flipping instantly. Because the optimistic flip happens identically whether or not the save round-trips, the user gets no signal that the change was actually persisted. Combined with the silent-failure issue above, the user cannot distinguish a real save from a no-op.
- **Fix:** Add a lightweight transient 'Saved' confirmation on the success branch (or a brief pending/saved state on the control), so the persisted state is visibly distinct from the in-flight optimistic state.
- **Files:** `apps/web/src/routes/settings/models.tsx`

#### D45 · 🟡 low · Copy-thread-id button gives no visible confirmation that anything was copied

- **User impact:** A user hovers a thread row, clicks the copy icon, and nothing changes — the icon stays a Copy glyph, no checkmark, no toast, no tooltip flip. There is no way to tell the click worked, so the user is left unsure whether the id is on their clipboard. Every other copy affordance in the app (the assistant-reply CopyButton) swaps to a Check icon for 2s; the sidebar copy is the lone exception.
- **Fix:** Reuse useCopyToClipboard in the row: track `copied` and swap the Copy icon to Check (mirroring CopyButton), or at minimum keep the icon highlighted briefly. The hook is already written and unmount-safe.
- **Files:** `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/CopyButton.tsx`, `apps/web/src/lib/hooks/useCopyToClipboard.ts`

#### D46 · 🟡 low · Long thread titles truncate with no tooltip or full-text reveal

- **User impact:** Thread titles are the raw prompt truncated to 80 characters by Core, and the sidebar (a fixed 256px-wide column) clips them again with CSS `truncate`. When several threads share a long common prefix (e.g. "Plan the Q3 roadmap for the ..."), the visible text is identical and there is no native `title=` tooltip on the row button, so the user cannot tell the threads apart or read the full title without opening each one.
- **Fix:** Add `title={item.title}` to the thread-open button so the full title surfaces on hover; consider an ellipsis on Core's 80-char truncation so the cut is visually honest.
- **Files:** `apps/web/src/components/Sidebar.tsx`, `crates/core/src/runs/thread_create.rs`


---

## Phase 3.5 — deep-review pass (pre-PR)

Ran the local multi-agent `deep-review` (8 specialists → adversarial verify) on the Phase-3 diff before opening the PR. **7 findings, all real (0 false positives dropped in verification), all nits** — every one a self-inflicted consistency gap in code this sweep itself added, now fixed:

1. **CopyThreadIdButton fake-success** — the new sidebar copy button hand-rolled optimistic `setCopied(true)` and showed a checkmark even when the clipboard write failed/was unavailable — the exact silent-clipboard class this sweep hardened `useCopyToClipboard` to kill. Refactored to reuse the hook (copied/failed/X), removing the duplication.
2. **CopyButton aria-live overclaim** — `aria-live` on a text-less icon button doesn't announce an aria-label change; moved the outcome into a visually-hidden `role="status"` text region (matching the ProposalCard pattern).
3. **Missing tests** — added `useCopyToClipboard.test.ts` (success / reject / no-API / reset), Sidebar copy-confirmation + failure tests, and a CommandPalette active-index re-clamp test (pins the Enter-no-op fix).

Verdict: clean — no blocking/important findings. The fixes are gated by the existing suites + the new tests.
