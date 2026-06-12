# web-component-tests

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## apps/web/src/rename-guard.test.ts — BANNED

PR1 (slice 9) purged the chat-role identifiers from `apps/web/src`. This guard reads every source file and asserts none reintroduce them, so the rename stays complete as later slices stack on it.

It is scoped to the chat-role *identifiers* — NOT a blunt "agent" substring — so:

- the automations domain ("agent run" comments + `Automation`/`AutomationRun` types in `data/mock/types.ts`) is intentionally NOT flagged, and
- the user-facing "Turn standup action items…" prompt copy in `data/mock/history.ts` is intentionally NOT flagged.

The guard file itself is excluded from the scan (it names the banned tokens).
