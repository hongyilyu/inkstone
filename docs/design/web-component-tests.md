# web-component-tests

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## apps/web/test/rename-guard.test.ts — BANNED

PR1 (slice 9) purged the chat-role identifiers from `apps/web/src`. This guard reads every source file and asserts none reintroduce them, so the rename stays complete as later slices stack on it.

It is scoped to the chat-role *identifiers* — NOT a blunt "agent" substring — so an
incidental "agent" in a comment or in user-facing prose (e.g. "agent run", "the
agent proposes…") is intentionally NOT flagged; only the banned chat-role
identifiers are.

The guard file itself is excluded from the scan (it names the banned tokens).
