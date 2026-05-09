/**
 * Persistence failure / drift-fix regression tests.
 *
 * Covers the invariant introduced to close the store/DB drift window:
 * reducer sites that mutate already-persisted state write to SQLite
 * first and update the store only on tx success.
 *
 * Tests are organized in four layers:
 *   1. Writer throw-propagation + `reportPersistenceError` dedup.
 *   2. `withTransaction` outer-catch for pre-writer failures
 *      (db-acquire / tx-open / SQLITE_BUSY before the body runs).
 *   3. `persist(writes, { onSuccess })` gates the follow-up store
 *      mutation on tx success — the persist-first pattern used at
 *      every reducer site that mutates already-persisted state.
 *   4. `persist(writes)` (no opts) preserves log-and-continue —
 *      pre-stream / best-effort sites where drift is benign or
 *      absorbed by load-time repair.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type PersistenceErrorContext,
	reportPersistenceError,
	setPersistenceErrorHandler,
} from "@backend/persistence/errors";
import {
	appendAgentMessage,
	appendDisplayMessage,
	createSession,
	finalizeDisplayMessageParts,
	newId,
	persist,
	type Tx,
	updateDisplayMessageMeta,
	withTransaction,
} from "@backend/persistence/sessions";
import type { DisplayMessage } from "@bridge/view-model";
import type { AssistantMessage } from "@mariozechner/pi-ai";

// Capture reports for assertion. Replaces the handler installed in
// preload.ts (none today); restore `null` after each test so the
// console.error fallback is the default between tests.
let reports: PersistenceErrorContext[] = [];

beforeEach(() => {
	reports = [];
	setPersistenceErrorHandler((ctx) => {
		reports.push(ctx);
	});
});

afterEach(() => {
	setPersistenceErrorHandler(null);
});

// ---------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------

function makeUserMsg(): DisplayMessage {
	return {
		id: newId(),
		role: "user",
		parts: [{ type: "text", text: "hello" }],
	};
}

function makeAssistantMsg(): DisplayMessage {
	return {
		id: newId(),
		role: "assistant",
		parts: [{ type: "text", text: "reply" }],
	};
}

function makeRawAssistant(): AssistantMessage {
	return {
		role: "assistant",
		provider: "openrouter",
		api: "openai-completions",
		model: "anthropic/claude-opus-4.7",
		content: [{ type: "text", text: "reply" }],
		stopReason: "end",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as unknown as AssistantMessage;
}

// ---------------------------------------------------------------
// Layer 1 — writers throw after reporting
// ---------------------------------------------------------------

describe("writers rethrow after reporting", () => {
	test("appendDisplayMessage throws on FK violation (non-existent session)", () => {
		expect(() =>
			withTransaction((tx: Tx) =>
				appendDisplayMessage(tx, "does-not-exist", makeUserMsg()),
			),
		).toThrow();

		// Writer reported once (FK violation), withTransaction's outer
		// catch saw the same rethrown error and was deduped by the
		// sentinel flag — so exactly ONE report, not two.
		expect(reports.length).toBe(1);
		expect(reports[0]?.kind).toBe("session");
		expect(reports[0]?.action).toMatch(/^append-message/);
	});

	test("updateDisplayMessageMeta throws on non-existent row — UPDATE is silent so no FK error, no throw", () => {
		// UPDATE with zero matching rows is not an error in SQLite; the
		// writer returns cleanly. Kept as a documentation test — a
		// future change that makes `updateDisplayMessageMeta` validate
		// row existence would flip this expectation.
		const msg = makeUserMsg();
		expect(() =>
			withTransaction((tx: Tx) =>
				updateDisplayMessageMeta(tx, "does-not-exist", msg),
			),
		).not.toThrow();
		expect(reports.length).toBe(0);
	});

	test("finalizeDisplayMessageParts throws on FK violation", () => {
		const msg = makeUserMsg();
		// `parts.message_id` FKs into `messages.id`. Without a messages
		// row, the INSERT fails. DELETE of zero rows is silent, so the
		// throw only fires when we try to INSERT the first part.
		expect(() =>
			withTransaction((tx: Tx) =>
				finalizeDisplayMessageParts(tx, "does-not-exist", msg),
			),
		).toThrow();
		expect(reports.length).toBe(1);
		expect(reports[0]?.action).toMatch(/^finalize-parts/);
	});

	test("appendAgentMessage throws on FK violation", () => {
		expect(() =>
			withTransaction((tx: Tx) =>
				appendAgentMessage(tx, "does-not-exist", makeRawAssistant()),
			),
		).toThrow();
		expect(reports.length).toBe(1);
		expect(reports[0]?.action).toBe("append-agent-message");
	});
});

// ---------------------------------------------------------------
// Layer 2 — dedup sentinel is scoped to withTransaction's outer catch
// ---------------------------------------------------------------

describe("dedup sentinel is tx-scoped, not global", () => {
	test("writer throw + tx outer catch fires handler exactly once", () => {
		// This is the only case the dedup machinery actually defends.
		// The writer reports via reportPersistenceError, then rethrows
		// through tagReportedAndRethrow which sets REPORTED_SENTINEL.
		// withTransaction's outer catch sees the same error, reads the
		// flag, and skips its own report — so one toast per failure.
		expect(() =>
			withTransaction((tx: Tx) =>
				appendDisplayMessage(tx, "does-not-exist", makeUserMsg()),
			),
		).toThrow();
		expect(reports.length).toBe(1);
		expect(reports[0]?.action).toMatch(/^append-message/);
	});

	test("same error reported twice through bare reportPersistenceError still fires twice", () => {
		// reportPersistenceError itself is NOT globally idempotent —
		// the sentinel only lives where withTransaction's outer catch
		// reads it. This keeps the flag out of the module's error-
		// carrying surface (config/auth load paths, external loggers
		// enumerating own properties).
		const err = new Error("boom");
		reportPersistenceError({ kind: "session", action: "first", error: err });
		reportPersistenceError({ kind: "session", action: "second", error: err });
		expect(reports.length).toBe(2);
	});

	test("distinct errors report independently", () => {
		reportPersistenceError({
			kind: "session",
			action: "a",
			error: new Error("one"),
		});
		reportPersistenceError({
			kind: "session",
			action: "b",
			error: new Error("two"),
		});
		expect(reports.length).toBe(2);
	});

	test("pre-writer tx failure is reported as action: 'tx'", () => {
		// Simulate a tx throw that didn't come through a writer's
		// report-and-tag path by throwing inside the tx body ourselves.
		// The sentinel isn't set, so withTransaction's outer catch
		// reports as `tx`.
		const err = new Error("mid-tx boom");
		expect(() =>
			withTransaction(() => {
				throw err;
			}),
		).toThrow();
		expect(reports.length).toBe(1);
		expect(reports[0]?.action).toBe("tx");
	});
});

// ---------------------------------------------------------------
// Layer 3 — persist({ onSuccess }) gates store mutation on tx success
// ---------------------------------------------------------------

describe("persist with onSuccess gates store mutation on tx success", () => {
	test("onSuccess fires when tx commits", () => {
		const sess = createSession({ agent: "reader" });
		let mutated = false;
		persist((tx) => appendDisplayMessage(tx, sess.id, makeUserMsg()), {
			onSuccess: () => {
				mutated = true;
			},
		});
		expect(mutated).toBe(true);
		expect(reports.length).toBe(0);
	});

	test("onSuccess is skipped when tx body throws", () => {
		let mutated = false;
		persist((tx) => appendDisplayMessage(tx, "does-not-exist", makeUserMsg()), {
			onSuccess: () => {
				mutated = true;
			},
		});
		expect(mutated).toBe(false);
		// Writer reported once, withTransaction's outer catch deduped.
		expect(reports.length).toBe(1);
	});

	test("onSuccess skipped when multi-writer tx fails mid-sequence (rollback + gate)", () => {
		// Mirrors `message_end`'s 3-writer atomic pattern: meta +
		// parts + raw AgentMessage. If appendAgentMessage fails, the
		// earlier updates must roll back and the store mutation must
		// not fire.
		const sess = createSession({ agent: "reader" });
		const assistantMsg = makeAssistantMsg();
		// Seed the row first so `updateDisplayMessageMeta` +
		// `finalizeDisplayMessageParts` targets exist.
		withTransaction((tx) => appendDisplayMessage(tx, sess.id, assistantMsg));

		let mutated = false;
		persist(
			(tx) => {
				updateDisplayMessageMeta(tx, sess.id, {
					...assistantMsg,
					agentName: "Reader",
					modelName: "Claude Opus 4.7",
				});
				finalizeDisplayMessageParts(tx, sess.id, assistantMsg);
				// Force a throw: bad FK on the raw message insert
				// (display_message_id points at a non-existent row).
				appendAgentMessage(tx, "does-not-exist", makeRawAssistant(), {
					displayMessageId: assistantMsg.id,
				});
			},
			{
				onSuccess: () => {
					mutated = true;
				},
			},
		);
		expect(mutated).toBe(false);
		expect(reports.length).toBe(1);
		expect(reports[0]?.action).toBe("append-agent-message");
	});
});

// ---------------------------------------------------------------
// Layer 4 — persist (no opts) preserves log-and-continue
// ---------------------------------------------------------------

describe("persist without opts swallows after reporting", () => {
	test("persist does not throw even when writer throws", () => {
		expect(() =>
			persist((tx) =>
				appendDisplayMessage(tx, "does-not-exist", makeUserMsg()),
			),
		).not.toThrow();
		expect(reports.length).toBe(1);
	});

	test("persist still runs the body on happy path", () => {
		const sess = createSession({ agent: "reader" });
		let ran = false;
		persist((tx) => {
			appendDisplayMessage(tx, sess.id, makeUserMsg());
			ran = true;
		});
		expect(ran).toBe(true);
		expect(reports.length).toBe(0);
	});
});
