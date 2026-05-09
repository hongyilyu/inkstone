# 0012 — Persistence writers require an explicit transaction

All persistence writers — `appendDisplayMessage`, `updateDisplayMessageMeta`, `finalizeDisplayMessageParts`, `appendAgentMessage` — take a **required** `tx: Tx` parameter and there is no auto-wrap fallback for single statements; callers that only need one write wrap explicitly with `persist((tx) => appendDisplayMessage(tx, sid, msg))` (or `withTransaction` directly for the throws-y path used by tests). The decision was forced by `message_end`'s three-artifact transaction (header meta update + parts DELETE-INSERT + raw `AgentMessage` append) — before the wrap landed, the three calls ran as separate implicit transactions and a mid-trio crash left orphans; once `message_end` had to be one tx, allowing other writers to opt out via auto-wrap created a two-mode contract that always invited the wrong mode at call sites needing atomicity.

The required-tx shape is deliberate ergonomic friction with three justifications:

1. **One code path** — no dual-mode writers, no `opts?.tx` branching, no `as TxLike` casts.
2. **Atomicity intent is local** — readers don't have to trace the call graph to figure out whether a write happens inside someone else's transaction.
3. **New writers can't forget** — adding a writer that joins a multi-write tx physically can't run without participating, because the type signature requires `tx`.

Reads (`loadSession`, `listSessions`) use the root client directly because they don't have atomicity concerns; the single session-row mutator (`createSession`) also uses the root client because one statement is auto-committed atomically by SQLite.
