# Product

## Register

product

## Users

A single user: the developer-owner of this local-first Workspace. Technical,
fluent in LLMs and agent tooling, using Inkstone as a thinking surface, capturing
conversations and structured personal knowledge (People, Projects, Todos,
Recipes) and exploring them through chat-driven agent Runs.

Context of use: focused sessions, often returning to a prior Thread to continue a
topic. Everything runs on their own machine (local-first, single-user per
ADR-0007). The user values control above all: nothing leaves the device, and
nothing is written to their durable knowledge without an explicit, reviewed
Proposal they approved.

## Product Purpose

Inkstone is a personal local-first application for exploring LLMs, agents, and
structured personal knowledge. The user types into a Thread; the Worker drives a
Run and surfaces Proposals; the user approves them into Accepted Entities.

Success looks like Inkstone becoming the user's daily thinking surface: chat is
fast and trustworthy, the knowledge it accrues (entities, todos, projects) is
browsable and findable rather than buried in conversation, and every change to
durable state passed through the user's explicit approval.

## Brand Personality

Characterful, trustworthy, unhurried. The voice is direct, warm, and human, never
corporate and never buzzwordy. The pink/magenta identity is a deliberate
signature, not decoration: this is a personal tool with a point of view that
isn't afraid to look like itself. The target feeling is the calm confidence of an
instrument that is *yours* and keeps your private thinking private.

## Anti-references

- **Generic SaaS dashboards** — endless identical card grids, hero-metric
  templates, Notion/Linear-clone genericness.
- **Corporate enterprise** — navy-and-gray palettes, stock photography, buzzword
  copy, sterile and impersonal.
- **Cluttered power-tools** — toolbar soup, dense nested menus, everything visible
  at once, no breathing room.

The test: it should read as a personal instrument someone chose, not software a
committee shipped.

## Design Principles

- **Approval is sacred.** Nothing touches durable knowledge without a visible,
  reviewable Proposal. The UI always makes "what will change" legible before it
  changes.
- **Chat is the verb, knowledge is the noun.** Conversation drives the system; the
  Entities it produces must be just as first-class — browsable, searchable, and
  worth returning to, not buried in scrollback.
- **Characterful, not loud.** The pink identity is the signature; lean into it
  with restraint. Personality comes from one committed color, confident type, and
  a few signature motifs, never from visual noise.
- **Local-first calm.** Single-user, on-device. No social proof, no
  engagement-bait, no dark patterns. The interface respects that this is private
  thinking.
- **Show the state, not a spinner.** Real empty, first-run, loading, and error
  states. The user always knows what Inkstone has and what it is doing.

## Accessibility & Inclusion

Proposed defaults (correct if your needs differ):

- Target **WCAG 2.1 AA**: body text ≥4.5:1, large text and UI affordances ≥3:1.
  The heavy reliance on pink makes contrast something to verify, not assume,
  especially `muted-foreground` on tinted surfaces.
- **Never encode meaning in color alone** (Proposal accept/reject, Entity kinds):
  always pair with an icon and a text label. Important given the near-monochrome
  pink palette and color-blind users.
- **Full keyboard operability** with visible `focus-visible` rings (already in the
  button primitive via `ring-ring`).
- Honor `prefers-color-scheme` (already wired) and `prefers-reduced-motion` for
  every animation.
