# Inkstone

A vault-aware TUI agent shell. Multiple personas (Reader, KB, …) share a vault, each scoped to its own context boundary, slash verbs, and permissions.

## Language

**Agent**:
A persona — a coherent system prompt + tool subset + permissions + slash verbs, isolated from every other agent so contexts can't bleed across sessions.
_Avoid_: persona (reserved for prose), assistant, bot

**Session**:
One in-memory lifetime bound to exactly one agent. A session's display history lives in `messages`; the LLM-shaped stream lives in `agent_messages`.
_Avoid_: conversation, thread

**Command**:
A user-typed verb at turn boundaries — either `AgentCommand` declared on `AgentInfo.commands` (`/article foo.md`) or shell-level `CommandOption` (`/clear`).
_Avoid_: action, slash command (use the `/`-prefix only when literally referring to one)

**Tool**:
An LLM-invoked capability mid-turn (`read`, `edit`, `write`, `dispatch`, …). Distinct from **Command** (user verb) and from agent (context boundary).
_Avoid_: function, action

**Vault**:
The user's knowledge directory, declared by `vaultDir` in `~/.config/inkstone/config.json`. Every read/write/edit baseline rule is anchored here.
_Avoid_: knowledge base (KB is the agent name), workspace, repo

**Fork**:
The session primitive that creates a child session bound to a chosen target agent, with `parent_session_id` set on the child and a seeded set of opening messages replayed into the child. Always a new session — never a swap on an existing one (per ADR 0008).
_Avoid_: branch, copy, switch

**Routing fork**:
A specialization of **Fork** triggered by the **Router** dispatching a freeform user message to a target agent. Same backend primitive as user-initiated fork; different TUI behavior (seamless seam vs new-session navigation).

**Router**:
A normal `AgentInfo` registry entry whose only job is to classify a freeform first message and call the `dispatch` tool. Stateless, first-message-only, sealed after dispatch. Router **Sessions** are backend infrastructure — persisted so the child's `parent_session_id` FK has a target and the `dispatch` tool-call has somewhere to live — but never surfaced in the sessions list; the user-visible routing breadcrumb is the child's **Forked-from marker**.
_Avoid_: classifier, dispatcher (dispatcher is the permission system)

**Dispatch**:
The tool the **Router** calls to perform a **Routing fork**. Takes one argument: the chosen target agent name (enum over the registry minus the router itself).
_Avoid_: route (verb), pick

**Forked-from marker**:
A display-only `parts` row of `type: "fork"` (distinct from `tool`) written to a child session when **any** fork completes. Has no `agent_messages` counterpart — the child agent's LLM context is naive to it. Distinct discriminant because a fork artifact is *not* an LLM tool call (per ADR 0005's agent/command/tool boundary); collapsing the two would push category recovery into a stringly-typed name field.
Today's payload is `{ parentSessionId }` only — there is exactly one caller (the router), so no caller discriminant is needed yet. An `originator: "router" | "user"` field is the planned extension point when user-initiated fork lands; it's deliberately not in the schema today (no flexibility that wasn't requested).
_Avoid_: routed-from marker, routing bubble, lineage row, fork tool-call

**Open page**:
The pre-commitment landing view shown when no agent is bound. Freeform text typed here goes to the **Router**; slash verbs and Tab picks bypass the router and commit directly.

## Relationships

- A **Session** is bound to exactly one **Agent** for its in-memory lifetime.
- A **Session** may have one **parent Session** (via `parent_session_id`) — set when the session is born from a **Fork**.
- Every **Fork** writes a **Forked-from marker** to the child session's `messages`. A **Routing fork** additionally has a `dispatch` tool-call in the parent (router) session — that's the LLM event that *caused* the fork; the marker is the event that *resulted from* it.
- The user's first message is persisted in **both** the router session and the child session — once as a normal user turn in each. The router sees it in `agent_messages`; the child sees it in both `messages` and `agent_messages`.
- A **Command** is owned by an **Agent** (`AgentInfo.commands`) or by the shell (`CommandOption`). A **Tool** is owned by an **Agent** (`extraTools` plus the shared base pool).

## Example dialogue

> **Dev:** "When the user types 'whats in foo' on the open page, what's a Session here?"
> **Domain expert:** "Two. The **Router** **Session** holds the user's message and the **dispatch** **Tool** call. The **Routing fork** creates a child **Session** bound to **Reader**, with a **Forked-from marker** as the first display row and the user's message replayed as turn 1 in both `messages` and `agent_messages`. The router's session is then sealed."
>
> **Dev:** "Why duplicate the user message?"
> **Domain expert:** "Each **Session** is self-contained on disk — `loadSession(sid)` returns everything needed to render it. The router persists the message because *it* received it; the child persists it because that's its turn 1 for the LLM. They're the same string in two **Sessions**, not the same row."
