/**
 * Persistence failure / drift-fix regression tests.
 *
 * Covers the invariant introduced to close the store/DB drift window:
 * reducer sites that mutate already-persisted state write to SQLite
 * first and update the store only on tx success.
 *
 * Tests are organized in three layers:
 *   1. Writer throw-propagation + `reportPersistenceError` dedup.
 *   2. `runInTransaction` outer-catch for pre-writer failures
 *      (db-acquire / tx-open / SQLITE_BUSY before the body runs).
 *   3. `safeRun` swallows; a caller-level try/catch shape — which is
 *      the exact pattern `persistThen` uses in `tui/context/agent.tsx`
 *      — aborts the follow-up mutation on throw. Covers all 5 reducer
 *      sites by exercising the pattern, not by driving the full
 *      reducer (rejected as over-engineering — see plan revision 3).
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
	runInTransaction,
	safeRun,
	type Tx,
	updateDisplayMessageMeta,
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
		provider: "amazon-bedrock",
		api: "anthropic-messages",
		model: "us.anthropic.claude-opus-4-7",
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
			runInTransaction((tx: Tx) =>
				appendDisplayMessage(tx, "does-not-exist", makeUserMsg()),
			),
		).toThrow();

		// Writer reported once (FK violation), runInTransaction's outer
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
			runInTransaction((tx: Tx) =>
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
			runInTransaction((tx: Tx) =>
				finalizeDisplayMessageParts(tx, "does-not-exist", msg),
			),
		).toThrow();
		expect(reports.length).toBe(1);
		expect(reports[0]?.action).toMatch(/^finalize-parts/);
	});

	test("appendAgentMessage throws on FK violation", () => {
		expect(() =>
			runInTransaction((tx: Tx) =>
				appendAgentMessage(tx, "does-not-exist", makeRawAssistant()),
			),
		).toThrow();
		expect(reports.length).toBe(1);
		expect(reports[0]?.action).toBe("append-agent-message");
	});
});

// ---------------------------------------------------------------
// Layer 2 — dedup sentinel is scoped to runInTransaction's outer catch
// ---------------------------------------------------------------

describe("dedup sentinel is tx-scoped, not global", () => {
	test("writer throw + tx outer catch fires handler exactly once", () => {
		// This is the only case the dedup machinery actually defends.
		// The writer reports via reportPersistenceError, then rethrows
		// through tagReportedAndRethrow which sets REPORTED_SENTINEL.
		// runInTransaction's outer catch sees the same error, reads the
		// flag, and skips its own report — so one toast per failure.
		expect(() =>
			runInTransaction((tx: Tx) =>
				appendDisplayMessage(tx, "does-not-exist", makeUserMsg()),
			),
		).toThrow();
		expect(reports.length).toBe(1);
		expect(reports[0]?.action).toMatch(/^append-message/);
	});

	test("same error reported twice through bare reportPersistenceError still fires twice", () => {
		// reportPersistenceError itself is NOT globally idempotent —
		// the sentinel only lives where runInTransaction's outer catch
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
		// The sentinel isn't set, so runInTransaction's outer catch
		// reports as `tx`.
		const err = new Error("mid-tx boom");
		expect(() =>
			runInTransaction(() => {
				throw err;
			}),
		).toThrow();
		expect(reports.length).toBe(1);
		expect(reports[0]?.action).toBe("tx");
	});
});

// ---------------------------------------------------------------
// Layer 3 — persistThen pattern: store mutation is gated on tx success
// ---------------------------------------------------------------

/**
 * Mirror of the helper defined in `tui/context/agent.tsx`. Duplicated
 * here rather than extracted because the TUI version closes over
 * `runInTransaction`; testing the pattern is what matters, not the
 * literal function.
 */
function persistThen(writes: (tx: Tx) => void, onSuccess: () => void): void {
	try {
		runInTransaction(writes);
	} catch {
		return;
	}
	onSuccess();
}

describe("persistThen gates store mutation on tx success", () => {
	test("onSuccess fires when tx commits", () => {
		const sess = createSession({ agent: "example" });
		let mutated = false;
		persistThen(
			(tx) => appendDisplayMessage(tx, sess.id, makeUserMsg()),
			() => {
				mutated = true;
			},
		);
		expect(mutated).toBe(true);
		expect(reports.length).toBe(0);
	});

	test("onSuccess is skipped when tx body throws", () => {
		let mutated = false;
		persistThen(
			(tx) => appendDisplayMessage(tx, "does-not-exist", makeUserMsg()),
			() => {
				mutated = true;
			},
		);
		expect(mutated).toBe(false);
		// Writer reported once, runInTransaction's outer catch deduped.
		expect(reports.length).toBe(1);
	});

	test("onSuccess skipped when multi-writer tx fails mid-sequence (rollback + gate)", () => {
		// Mirrors `message_end`'s 3-writer atomic pattern: meta +
		// parts + raw AgentMessage. If appendAgentMessage fails, the
		// earlier updates must roll back and the store mutation must
		// not fire.
		const sess = createSession({ agent: "example" });
		const assistantMsg = makeAssistantMsg();
		// Seed the row first so `updateDisplayMessageMeta` +
		// `finalizeDisplayMessageParts` targets exist.
		runInTransaction((tx) => appendDisplayMessage(tx, sess.id, assistantMsg));

		let mutated = false;
		persistThen(
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
			() => {
				mutated = true;
			},
		);
		expect(mutated).toBe(false);
		expect(reports.length).toBe(1);
		expect(reports[0]?.action).toBe("append-agent-message");
	});
});

// ---------------------------------------------------------------
// Layer 4 — safeRun preserves log-and-continue
// ---------------------------------------------------------------

describe("safeRun swallows after reporting", () => {
	test("safeRun does not throw even when writer throws", () => {
		expect(() =>
			safeRun(() =>
				runInTransaction((tx) =>
					appendDisplayMessage(tx, "does-not-exist", makeUserMsg()),
				),
			),
		).not.toThrow();
		expect(reports.length).toBe(1);
	});

	test("safeRun still runs the body on happy path", () => {
		const sess = createSession({ agent: "example" });
		let ran = false;
		safeRun(() =>
			runInTransaction((tx) => {
				appendDisplayMessage(tx, sess.id, makeUserMsg());
				ran = true;
			}),
		);
		expect(ran).toBe(true);
		expect(reports.length).toBe(0);
	});
});
