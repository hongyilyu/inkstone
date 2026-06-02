# Inkstone

Inkstone is a personal local-first application for exploring LLMs, agents, structured personal knowledge, and Rust/TypeScript system design. This glossary is the canonical vocabulary for the project — code, ADRs, issues, and docs should use these terms.

## Language

### Components

**Core**:
The Rust component that owns durable Workspace state, file and database access, controlled integrations, and coordination between Clients and the Worker.
_Avoid_: Rust Core, workspace daemon, backend, server.

**Worker**:
The TypeScript component that drives Runs to completion by executing Turns, and owns LLM-provider interaction. Receives Runs from Core, emits Run Events back, and requests Core-owned capabilities through the Tool Protocol.
_Avoid_: Agent Runtime, TypeScript Agent Runtime, TypeScript Worker, runtime.

**Workspace**:
The full local Inkstone state on disk that Core opens and operates against — the vault directory, SQLite database, config, and runtime artifacts taken as a unit. The "unit" is logical, not physical: the Vault is wherever the user keeps it; Core-managed state (DB, config) lives in the OS application-data directory. Inkstone may eventually support multiple workspaces; only one is open per Core process. The MVP supports exactly one Workspace per install.
_Avoid_: project, environment, instance.

**Vault**:
The directory of human-authored and externally captured source content inside a Workspace — Obsidian-readable markdown, raw captures, and documents the user expects to own and edit directly. Canonical for source content; not canonical for application state.
_Avoid_: notes folder, content directory.

**Client**:
Any process that talks to Core through Core's client surface. Includes graphical surfaces (Web, TUI, Desktop, Mobile) and non-graphical ones (capture scripts, CLIs). A Client never accesses the SQLite database, the Vault, the Worker, or LLM providers directly.
_Avoid_: UI, UI Client, frontend (use "Web Client" / "TUI Client" / "Capture Client" for specific subtypes).

**Capture Client**:
A Client whose sole job is to ingest content into the Workspace — clipping articles, piping text into Inkstone, mobile share-sheet captures, and similar. Distinguished from interactive clients by being one-shot and non-conversational.

**Test Harness**:
A non-product package that drives end-to-end tests against a real Core, real Worker, and a real Web Client in a headless browser. Spawns Core against a temporary Workspace, configures the Worker to use a mock LLM provider, and asserts behavior through the same surfaces a real user touches. Not a Client (it tests Core's client surface rather than using it for product purposes). Lives outside `apps/`, `crates/`, and `packages/`.
_Avoid_: test runner (too generic), e2e suite (the suite is a thing the Test Harness runs).

**Auth Helper**:
A stateless TypeScript process Core spawns to run provider OAuth via `pi-ai` — `login` mode (PKCE flow + loopback callback, returns credentials) and `refresh` mode (rotates an expired token). It holds no durable state; it hands its result back to Core on stdout, and Core writes the Credential Store. Distinct from the Worker (which drives Runs) though both live in `packages/worker` and depend on `pi-ai`.
_Avoid_: auth worker, login worker, oauth client.

### Execution

**Thread**:
A durable conversation, scoped to a Workspace. Contains one or more Runs. The unit a user returns to when continuing a prior topic.

**Run**:
One user request handled end-to-end within a Thread. Durable, cancellable, individually addressable. A Run contains one or more Turns and concludes with a final assistant response, an error, or cancellation.

**Turn**:
One LLM call and the model's response. A Turn ends when the model returns either a final answer (which ends the Run) or one or more tool calls (which trigger Core-side execution before the next Turn begins). A Run is exactly N Turns where N - 1 ended in tool calls and the last ended in a final answer.
_Avoid_: step, iteration, exchange.

### Protocol

**Run Event**:
A one-way message emitted by the Worker to Core during a Run, describing what is happening. Subtypes include `text_delta`, `status`, `done`, and `error`. Run Events are observational — Core consumes, persists, and forwards them; the Worker does not await a response.
_Avoid_: event (too generic), output, stream item.

**Tool Request**:
A message from the Worker to Core asking Core to perform a Core-owned action — read a file, query indexed notes, submit a Proposal for user approval, etc. Always paired with a Tool Result.
_Avoid_: tool call, action request.

**Tool Result**:
Core's reply to a Tool Request, carrying the outcome of the requested action (data, success/failure, or a user decision in the case of a Proposal).
_Avoid_: tool response, action result.

**Tool Protocol**:
The bidirectional Worker ↔ Core channel carrying Tool Requests and Tool Results. Distinct from the one-way Run Event stream.

**Proposal**:
A structured description of a change the Worker wants to make to the Workspace, awaiting an explicit user decision before Core applies it. Carries enough context for review (what, why, where, diff where applicable) and is applied atomically on acceptance. Submitted as a Tool Request; the Tool Result carries the user's decision (accept, reject, edit). Which operations require a Proposal vs. apply directly is a policy decision tracked elsewhere.
_Avoid_: suggestion, draft, pending change.

### Storage

Inkstone has three persistence tiers. Authority is scoped by *what kind of fact is being stored*, not by storage location — Vault Files and SQLite Canonical State are both authoritative, for different claims.

**Vault Files** (tier 1, authoritative):
Authoritative for user-owned and imported source content — what the user actually wrote or captured.

**SQLite Canonical State** (tier 2, authoritative):
Authoritative for Inkstone-managed durable application state — Threads, Runs, Proposals, Accepted Entities, ingestion and reconciliation bookkeeping, approvals.

**SQLite Projections** (tier 3, derived):
Re-derivable indexes and views computed from tiers 1 and 2 — FTS, extraction candidates, backlinks, dashboards, denormalized views. Authoritative for nothing; lost projections can always be rebuilt.
_Avoid_: indexes (when meaning the whole tier), derived state (ambiguous with non-projection derivations).

**Credential Store**:
The Core-owned file holding provider OAuth credentials (`access`, `refresh`, `expires`, `accountId`), kept `0600` beside the SQLite database. Outside the three-tier model by design — ADR-0007 carves provider credentials out as "a separate concern," so they are neither tier-2 canonical state nor a tier-3 projection. Core is the single writer; the Worker never sees the refresh token, only a short-lived access token in its manifest.
_Avoid_: token store, secrets store, auth db.

**Source Content**:
Tier-1 material in the Vault: notes, raw captures, articles, anything the user authors or imports and expects to own directly.

**Message**:
A tier-2 storage record for one bubble in the chat UI — a user prompt, an assistant response, or similar. Has many Message Parts. *Not* a domain concept (the domain has Threads, Runs, Turns); this is the storage shape for what the user sees rendered in a Thread, modeled after the chat-API content-block convention. Each Message belongs to exactly one Run.

**Message Part**:
One ordered chunk inside a Message — a text block, an attachment reference, a marker for an inline tool call, etc. Composite key `(message_id, seq)`. Polymorphic by `type`; payloads beyond plain text are JSON. Tool calls and tool results are *not* Message Parts — they live in their own table and are interleaved with Messages at render time via Run Steps.

**Snapshot**:
The byte content of a Vault file at a stable instant, plus its content hash. The trustworthy unit Core builds on — distinct from raw watcher events, which can fire while a file is mid-write or be re-ordered by sync.

**Ingestion**:
The pipeline that turns a fresh Snapshot into accepted state Core can build on: take Snapshot, compute identity/hash, record bookkeeping, derive projections, commit transactionally.

**Reconciliation**:
The act of keeping SQLite consistent with the current Vault state. Includes ingesting new Snapshots, removing projections for deleted files, handling renames, and resolving conflicts when both Vault and Worker have produced changes against the same content.

### Domain

**Entity**:
A structured concept Inkstone tracks for query and reasoning — a Person, Project, Todo, Recipe, etc. An Entity has a lifecycle: it begins as an *extraction candidate* in tier 3 (projection) or as a user creation, becomes a Proposal in tier 2, and on acceptance becomes a canonical Entity record in tier 2. Threads, Runs, and Proposals are not Entities — they are application state.
_Avoid_: object, record, item.

**Extraction Candidate**:
A possible Entity surfaced by parsing or agent extraction, living in tier 3. Not yet ratified. Becomes an Accepted Entity only after passing through a Proposal.
_Avoid_: extracted entity (ambiguous with the accepted form), suggestion.

**Accepted Entity**:
An Entity record in tier 2 — created either by user action, by accepting a Proposal, or by Reconciliation linking existing records to Vault content.

### Agents

**Workflow**:
The runnable unit of agent behavior. Each Workflow defines its own system prompt, tool allowlist, model choice, and any bootstrap context. One Run executes exactly one Workflow. Workflows are the primitive — there is no higher grouping (no "Agent" object). Code-level organization of related Workflows is implementation detail, not vocabulary.
_Avoid_: agent, command, skill, task.

**Dispatcher**:
The Core-side seam that picks a Workflow for each Run. Called once at Run creation, before the Worker starts. Always present, even when only one Workflow exists; in that case the Dispatcher is a one-liner that returns the single Workflow. The strategy *inside* the Dispatcher (hard-coded, deterministic, LLM-driven, user-picker) is a separate concern.

**Router**:
A possible implementation strategy for the Dispatcher — a non-trivial Workflow selector (keyword classifier, LLM call, user picker, hybrid). Whether a Router exists in the MVP stays open; the Dispatcher exists either way. Threads carry conversation history but do not lock the next Run to a specific Workflow.
_Avoid_: classifier (one possible implementation, not the role).

## Example dialogue

A back-and-forth between two contributors walking through a daily-capture flow. The terms appear in the order they are encountered, and the dialogue forces several disambiguations.

> **A:** I just typed an interstitial entry into today's daily note: "Met Alice about the daycare transition. Need to send her the schedule by Friday." Where does that go from here?
>
> **B:** It goes into your **Vault** — it's just a Vault File. The fact that you wrote it is the only authoritative thing right now.
>
> **A:** And then the watcher fires?
>
> **B:** The watcher *might* fire — but Core won't trust the raw event. It'll grab a **Snapshot** of the file at a stable instant and hash it. The Snapshot is what the rest of the pipeline operates on.
>
> **A:** Why not just re-read the file?
>
> **B:** Because the file might be mid-write or the sync layer might re-order events. The Snapshot is the only thing that's safe to build on.
>
> **A:** Okay, then what?
>
> **B:** **Ingestion** runs. That's the pipeline that turns the Snapshot into accepted state. Bookkeeping in tier 2, derived projections in tier 3 — for example, the parser sees "Alice" and "Friday" and creates **Extraction Candidates**.
>
> **A:** Wait — Alice becomes an Entity?
>
> **B:** Not yet. An **Extraction Candidate** is a possible Entity living in tier 3. It hasn't been ratified. To become an **Accepted Entity** it has to pass through a **Proposal**.
>
> **A:** Who creates the Proposal?
>
> **B:** The **Worker**, during a Run. You'll have a Workflow that scans recent captures, sees the candidate, and submits a Proposal asking you to confirm: "Create Person 'Alice', link to today's note, set Todo 'Send Alice the schedule, due Friday'."
>
> **A:** And the Proposal is one of those Run Events?
>
> **B:** No — that's the disambiguation that gets people. A **Run Event** is one-way Worker → Core: text deltas, status, errors. The Worker doesn't await anything. A **Proposal** isn't fire-and-forget; the Worker needs your decision before it can continue. So a Proposal rides the **Tool Protocol** — it's a **Tool Request**, and Core will return a **Tool Result** carrying your accept/reject/edit.
>
> **A:** I accept the Proposal. Now what?
>
> **B:** Core applies the change atomically. The Person record and the Todo land in tier 2 as **Accepted Entities**. The link from today's note to Alice goes into tier 3 as a derived projection.
>
> **A:** And later when I query "what do I owe Alice?"
>
> **B:** That hits tier 3 — it's an FTS or backlink lookup. If we ever lost tier 3 we could rebuild it from your Vault and tier 2. We couldn't rebuild *Alice herself* that way, because the decision to create her happened through a Proposal you approved, and that decision is tier 2.

Notable disambiguations the dialogue exercises: Vault File vs Snapshot; Snapshot vs Ingestion; Extraction Candidate vs Accepted Entity; Proposal vs Run Event; Tier 2 vs Tier 3 authority.

