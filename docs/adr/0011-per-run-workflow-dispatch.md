# Per-Run Workflow dispatch is an explicit seam

A Thread does not bind to a Workflow. Each Run picks its Workflow through an explicit **Dispatcher** step inside Core, called once when the Run is created. In the MVP the Dispatcher is hard-coded to return the single Workflow that exists, but the step is named in the architecture so that adding a second Workflow is a Dispatcher implementation change, not a structural one.

## Why per-Run, not per-Thread

A user naturally crosses modes mid-conversation — capture an interstitial entry, then ask a calendar question, then ask the agent to summarise. Forcing one Workflow per Thread either fragments the conversation across many short Threads or surfaces a Workflow picker at Thread creation that contradicts how the user actually thinks. CONTEXT.md commits to this: "Threads carry conversation history but do not lock the next Run to a specific Workflow."

## Why name the seam now, even with one Workflow

Slice 1 has exactly one Workflow, so the Dispatcher's body is `return the_only_workflow`. Two reasonable engineers will disagree about whether that warrants a named primitive.

Naming it wins on two grounds:

- **The step is real even when trivial.** Run creation has to answer "which Workflow drives this Run?" — that question is asked once, in one place, regardless of whether the answer is currently fixed. A named Dispatcher makes that location obvious; an inline hard-wire scatters the same decision across whatever code paths create Runs.
- **Slice 2 will need it.** A capture-recognition Workflow alongside a general-chat Workflow forces the choice. Naming the seam now means slice 2's change is "give the Dispatcher real logic," not "introduce a Dispatcher and migrate every Run-creation site."

## Vocabulary

- **Dispatcher** — the seam. The component called once per Run to choose a Workflow. New term; add to CONTEXT.md.
- **Router** — already in CONTEXT.md. A possible *implementation* of the Dispatcher (deterministic classifier, LLM call, user picker, hybrid). Whether the MVP has a Router stays open; the MVP definitely has a Dispatcher.

## Consequences

- The Web Client's "new Thread" action takes no Workflow argument.
- Core's Run-creation path calls the Dispatcher; the Worker is told which Workflow to run.
- The Dispatcher is in Core, not the Worker. Workflow choice is a coordination decision, not an agent-loop decision.
- The MVP Dispatcher is one line. That is intentional and not a smell.

## Considered and rejected

- **Thread-bound Workflow.** Each Thread is created with a Workflow and every Run inherits it. Rejected because it forces the user to pre-commit to a mode and breaks naturally cross-mode conversations. Already rejected during the prior glossary work; this ADR records the architectural consequence.
- **Per-Run dispatch with the seam deferred.** Identical user behavior, no `Dispatcher` type until Workflow #2 lands. Rejected because the extraction would touch every Run-creation site and the cost of naming now is one trait and one struct.

## Related

- [ADR-0010](./0010-mvp-slice-chat-driven-web-client.md) — the slice this Dispatcher serves.
- CONTEXT.md `Workflow`, `Router` — `Dispatcher` will be added alongside.
