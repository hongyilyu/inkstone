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
A tier-3 derived export directory inside a Workspace — a regenerated, human-readable rendering of tier-2 content (e.g. Obsidian-readable markdown). One-way: Core writes the Vault from tier 2; Core never reads it back as authority. External edits to exported files are not preserved.
_Avoid_: notes folder, content directory, source directory.

**Client**:
Any process that talks to Core through Core's client surface. Includes graphical surfaces (Web, TUI, Desktop, Mobile) and non-graphical ones (capture scripts, CLIs). A Client never accesses the SQLite database, the Vault, the Worker, or LLM providers directly.
_Avoid_: UI, UI Client, frontend (use "Web Client" / "TUI Client" / "Capture Client" for specific subtypes).

**Capture Client**:
A Client whose sole job is to ingest content into the Workspace — clipping articles, piping text into Inkstone, mobile share-sheet captures, and similar. Writes to tier-2 SQLite via Core's client surface like any other Client, not by dropping files into the Vault. Distinguished from interactive clients by being one-shot and non-conversational.

**Test Harness**:
A non-product package that drives end-to-end tests against a real Core, real Worker, and a real Web Client in a headless browser. Spawns Core against a temporary Workspace, configures the Worker to use a mock LLM provider, and asserts behavior through the same surfaces a real user touches. Not a Client (it tests Core's client surface rather than using it for product purposes). Lives outside `apps/`, `crates/`, and `packages/`.
_Avoid_: test runner (too generic), e2e suite (the suite is a thing the Test Harness runs).

**Provider Helper**:
A stateless TypeScript process Core spawns to run LLM-provider OAuth via `pi-ai` — `login` mode (PKCE flow + loopback callback, returns credentials) and `refresh` mode (rotates an expired token). It holds no durable state; it hands its result back to Core on stdout, and Core writes the Credential Store. Distinct from the Worker (which drives Runs) though both live in `packages/worker` and depend on `pi-ai`. Named "provider", not "auth", because ADR-0007 reserves auth for the (absent) human-auth concern — this is LLM-provider connection.
_Avoid_: auth helper, login worker, oauth client.

### Execution

**Thread**:
A durable conversation, scoped to a Workspace. Contains one or more Runs. The unit a user returns to when continuing a prior topic.

**Run**:
One user request handled end-to-end within a Thread. Durable, cancellable, individually addressable. A Run contains one or more Turns and concludes with a final assistant response, an error, or cancellation.

**Turn**:
One LLM call and the model's response. A Turn ends when the model returns either a final answer (which ends the Run) or one or more tool calls (which trigger Core-side execution before the next Turn begins). A Run is exactly N Turns where N - 1 ended in tool calls and the last ended in a final answer.
_Avoid_: step, iteration, exchange.

**Parked**:
A Run state: the Run is waiting on a user **Decision** for a **Proposal** before it can continue. Durable and non-terminal — Core tears the Worker down while parked and resumes the Run when the Decision arrives; a parked Run survives a Core restart.
_Avoid_: paused, suspended, blocked, waiting.

**Resume**:
Continuing a parked Run once its Decision is in: Core spawns a fresh Worker, replays the Run's transcript from tier 2 with the Decision as the awaited tool's Tool Result, and the agent loop continues from the next Turn.
_Avoid_: restart (that creates a new Run), retry, continue (overloaded).

**Run status**:
The materialized lifecycle state of a Run, authoritative in tier 2. One of: **running** (a Worker is driving it), **parked** (waiting on a Decision; non-terminal, survives a Core restart), **completed** (ended with a final answer), **errored** (ended in failure), **cancelled** (ended by user cancellation). A Run moves between these only through guarded *transitions*, never a free-form status write; the legal moves are `running → {completed, errored, parked, cancelled}` and `parked → {running, cancelled}`. An accepted cancellation of a running Run wins the Run: a later completion does not change it to completed. The parallel **Proposal status** (`pending → {accepted, rejected, cancelled}`) is the same shape. Derived from what the Worker did, then recorded — distinct from a Run Event, which only observes.
_Avoid_: state (too generic), phase, stage.

### Protocol

**Run Event**:
A one-way, observational message Core forwards to Clients during a Run; nothing awaits a response. Most are emitted by the Worker (`text_delta`, `done`, `error`), but two are Core-synthesized: `tool_call` (from a Tool Request) and `cancelled` (after Core wins a `run/cancel`). `cancelled` is terminal, but not an `error`. Distinct from the **Run Log**: a Run Event is the ephemeral wire signal Core forwards to Clients, the Run Log is Core's durable record of a milestone.
_Avoid_: event (too generic), output, stream item; Run Log (the durable Core-authored record — a different concept).

**Tool Request**:
A message from the Worker to Core asking Core to perform a Core-owned action — query indexed entities, submit a Proposal for user approval, etc. Always paired with a Tool Result.
_Avoid_: tool call, action request.

**Tool Result**:
Core's reply to a Tool Request, carrying the outcome of the requested action (data, success/failure, or a user decision in the case of a Proposal).
_Avoid_: tool response, action result.

**Tool Protocol**:
The bidirectional Worker ↔ Core channel carrying Tool Requests and Tool Results. Distinct from the one-way Run Event stream.

**Proposal**:
A structured description of a change the Worker wants to make to the Workspace, awaiting an explicit user decision before Core applies it. Carries enough context for review (what, why, where, diff where applicable) and is applied atomically on acceptance. Submitted as a Tool Request; the Tool Result carries the user's decision (accept, reject, edit). Which operations require a Proposal vs. apply directly is a policy decision tracked elsewhere.
_Avoid_: suggestion, draft, pending change.

**Decision**:
The user's resolution of a Proposal — **accept**, **reject**, or **edit** — carried back to the Worker as the Proposal's Tool Result. An *edit* supplies a modified payload that Core validates and applies in place of the proposed one; a *reject* is a normal (non-error) Tool Result so the Run continues conversationally.
_Avoid_: approval (covers only accept), response, verdict.

### Storage

Inkstone has two persistence tiers. SQLite is authoritative for everything Core durably owns; the Vault is a derived export.

**SQLite Canonical State** (tier 2, authoritative):
Authoritative for all content and Inkstone-managed durable application state — Threads, Runs, Proposals, Accepted Entities, approvals, and captured content.

**Derived Projections** (tier 3, derived):
Re-derivable indexes, views, and exports computed from tier 2 — FTS, extraction candidates, backlinks, dashboards, denormalized views, and the Vault's exported documents. Authoritative for nothing; lost projections can always be rebuilt.
_Avoid_: indexes (when meaning the whole tier), derived state (ambiguous with non-projection derivations).

**Credential Store**:
The Core-owned file holding provider OAuth credentials (`access`, `refresh`, `expires`, `account_id`), kept `0600` in a `credentials/` directory next to the SQLite database. Outside the tier model by design — ADR-0007 carves provider credentials out as "a separate concern," so they are neither tier-2 canonical state nor a tier-3 projection. Core is the single writer; the Worker never sees the refresh token, only a short-lived access token in its manifest.
_Avoid_: token store, secrets store, auth db.

**Message**:
A tier-2 storage record for one bubble in the chat UI — a user prompt, an assistant response, or similar. Has many Message Parts. *Not* a domain concept (the domain has Threads, Runs, Turns); this is the storage shape for what the user sees rendered in a Thread, modeled after the chat-API content-block convention. Each Message belongs to exactly one Run.

**Message Part**:
One ordered chunk inside a Message — a text block, an attachment reference, a marker for an inline tool call, etc. Composite key `(message_id, seq)`. Polymorphic by `type`; payloads beyond plain text are JSON. Tool calls and tool results are *not* Message Parts — they live in their own table and are interleaved with Messages at render time via Run Steps.

**Run Log**:
Core's durable tier-2 record of a Run's lifecycle milestones — one ordered row per milestone, keyed `(run_id, run_seq)`, discriminated by a **Run Log Kind** (`running`, `parked`, `done`, `error`, `cancelled`, `proposal_pending`, `proposal_decided`). Written by the Run status transition verbs (ADR-0028) as each change commits; authoritative for nothing and read by nothing yet — it pre-pays a future `run/get_history`. Distinct from a **Run Event** (the ephemeral wire stream) and from Run status (the materialized cell whose changes it records).
_Avoid_: run events (that names the wire stream), audit log, event stream, run timeline (that's the rendered Message / Tool Call sequence).

### Domain

**Entity**:
A structured concept Inkstone tracks for query and reasoning — a Journal Entry, Person, Project, Todo, Recipe, etc. An Entity has a lifecycle: it begins as an *extraction candidate* in tier 3 (projection) or as a user creation, becomes a Proposal in tier 2, and on acceptance becomes a canonical Entity record in tier 2. Threads, Runs, and Proposals are not Entities — they are application state.
_Avoid_: object, record, item.

**Journal Entry**:
A canonical event/evidence Entity refined from one or more user source Messages. One Message may produce multiple Journal Entries, and one Journal Entry may later be refined by user Messages from multiple Threads. A Journal Entry records what happened, when it happened, and the accepted wording the user wants Inkstone to remember. Person, Project, and Todo Entities may be extracted from a Journal Entry, but they own their own current state after acceptance.
_Avoid_: raw chat log, daily note row.

**Daily Note**:
A derived date-grouped view over Journal Entries, grouped by the entries' occurred time. It is not an Entity in the first model: editing, referencing, and provenance happen on the underlying Journal Entries and related Entities, and the Daily Note renders the current collection for a local day.
_Avoid_: daily entity, daily document as source of truth.

**Extraction Candidate**:
A possible Entity surfaced by parsing or agent extraction, living in tier 3. Not yet ratified. Becomes an Accepted Entity only after passing through a Proposal.
_Avoid_: extracted entity (ambiguous with the accepted form), suggestion.

**Accepted Entity**:
An Entity record in tier 2 — created either by user action or by accepting a Proposal.

**Entity Type**:
The kind of structured concept an Entity is — Journal Entry, Todo, Person, Project, Recipe, etc. Determines how the Entity's content is validated, versioned, and described back to the Worker when a Proposal that creates it is accepted. Distinct from the *change* a Proposal makes (create / update / delete): the Entity Type is *what the thing is*, the change is *what is being done to it*.
_Avoid_: kind (overloaded across unrelated discriminators), entity class, entity category.

**Entity Source**:
A provenance relationship that explains where an Entity came from or what evidence supports it. A Journal Entry can source from one or more user Messages; a Person, Project, or Todo extracted from a journal flow can source from the Journal Entry. Entity Sources answer "why does this Entity exist?" Assistant Messages are Thread context, not Entity Sources.
_Avoid_: audit log, link.

**Entity Reference**:
A Journal Entry inline reference to an Accepted Entity. Entity References are addressed from Journal Entry body nodes and let the rendered entry point at the referenced Person, Project, or Todo while keeping the referenced Entity's data independent. They power backlinks and reference queries for journal entries in the first model.
_Avoid_: source, mention, generic link.

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

A back-and-forth between two contributors walking through an extraction flow. The terms appear in the order they are encountered, and the dialogue forces several disambiguations.

> **A:** I just typed into a Thread: "Met Alice about the daycare transition. Need to send her the schedule by Friday." Where does that go from here?
>
> **B:** It's a user **Message** in tier 2 — that's the first authoritative trace. Nothing outside SQLite holds it.
>
> **A:** Not the Vault?
>
> **B:** No. The Vault is a tier-3 derived export — Core writes rendered documents into it from tier 2, never the other way around. The bytes you typed live in `messages` / `message_parts`, not in a file Core would read back.
>
> **A:** Okay, then what?
>
> **B:** Your Message starts a **Run**. The **Dispatcher** picks a **Workflow**, the **Worker** drives the Run, and the journaling Workflow first proposes a **Journal Entry** if the Message is worth capturing as an event. Once that Journal Entry is accepted, the Worker notices "Alice" and "Friday" look like a Person and a Todo worth tracking. Those are **Extraction Candidates** — possible Entities, living in tier 3.
>
> **A:** Wait — Alice becomes an Entity?
>
> **B:** Not yet. An **Extraction Candidate** is a possible Entity in tier 3. It hasn't been ratified. To become an **Accepted Entity** it has to pass through a **Proposal**.
>
> **A:** Who creates the Proposal?
>
> **B:** The Worker, during the Run. The Workflow submits Proposals one at a time: first "Create this Journal Entry," then, after it is accepted, "Create Person 'Alice'" or "Create Todo 'Send Alice the schedule, due Friday'." The accepted Journal Entry becomes the provenance source for the extracted Entities.
>
> **A:** And the Proposal is one of those Run Events?
>
> **B:** No — that's the disambiguation that gets people. A **Run Event** is one-way, fire-and-forget: text deltas, tool-call markers, completion, cancellation, errors stream out to the Client and nothing awaits a reply (most come from the Worker; tool-call and cancellation are Core-synthesized). A **Proposal** isn't fire-and-forget; the Worker needs your decision before it can continue. So a Proposal rides the **Tool Protocol** — it's a **Tool Request**, and Core will return a **Tool Result** carrying your accept / reject / edit.
>
> **A:** I accept the Proposal. Now what?
>
> **B:** Core applies each accepted change atomically. The Journal Entry, Person record, and Todo land in tier 2 as **Accepted Entities**. Core records **Entity Sources** so the Person and Todo point back to the Journal Entry, and **Entity References** so reference queries can find inline journal references. Anything derived — search index, backlinks, the Vault export's rendered pages if the export is configured to render them — gets rebuilt in tier 3.
>
> **A:** And later when I query "what do I owe Alice?"
>
> **B:** That hits tier 3 — an FTS or backlink lookup. If we ever lost tier 3 we could rebuild it from tier 2. We couldn't rebuild *Alice herself* that way, because the decision to create her happened through a Proposal you approved, and that decision is tier 2.

Notable disambiguations the dialogue exercises: tier 2 vs tier 3 authority; Vault as derived export, not source; Journal Entry as accepted event record vs Message as chat input; Extraction Candidate vs Accepted Entity; Proposal vs Run Event.
