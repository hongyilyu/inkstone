# 0011 — Workflow placement: system prompt vs user message

Command-workflow text (stages, file rules, preservation logic) lives in different places for different agents:

- **Reader's `/article` workflow** → opening user message written by the command's `prompt(text)` callback.
- **KB's `/lint` / `/query` / `/ingest` workflows** → baked into the agent's system prompt.

The divergence is intentional, driven by two trigger conditions:

**Trigger 1 — does the command inject variable per-invocation content?**
Reader's `/article foo.md` carries the article content (2-50KB, varies per call), which forces user-message placement to keep ADR 0005's system-prompt stability invariant intact — otherwise every article invalidates the cached system prefix. Placing the workflow alongside its content in the same user message is the natural follow-on. KB's commands inject no variable content, so this trigger doesn't fire.

**Trigger 2 — does the agent have a legitimate plain-chat mode?**
Reader sessions can be non-workflow ("what did I save yesterday?", "browsing my library"); workflow text in the system prompt biased the LLM toward Stage-1 mode-selection on plain-chat turns, so deferring the workflow to user-message-on-invocation lets plain chat stay in-character. KB has no plain-chat mode — every KB session is for one of the three workflows — so system-prompt placement carries no bias cost and gives the LLM cross-command awareness from turn 1 (it can recognize mid-session that an `/lint` query was actually a `/query` and route correctly).

Forcing consistency in either direction was rejected:

- **All-in-system-prompt** either reintroduces Reader's plain-chat bias OR requires conditional prose ("ignore the workflow below if no article has been provided") that wastes tokens and is a known-iffy LLM instruction pattern.
- **All-in-user-message** breaks KB's cross-command intelligence by making each workflow visible only after its trigger has fired.

Steady-state cost is approximately equivalent in both placements because cache-control pins the user-message prefix after turn 1, so per-turn cost on turns 2+ matches the system-prompt placement; turn 1 is slightly more expensive when content is uncached, but that cost was always going to land somewhere. Future agents place their workflows by checking the two triggers; if the next several agents all look like KB, this ADR gets revised toward "system prompt is default; user-message is the escape hatch."
