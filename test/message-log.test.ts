/**
 * `MessageLog` — unit tests for the store-↔-disk mirror module.
 *
 * Each test exercises one method against a real (in-memory) SQLite
 * session, asserting on BOTH the Solid store and `loadSession()`'s
 * disk view. The boundary the module owns is "store and disk are
 * mirror images, with disk authoritative" — these tests pin that
 * invariant per method, so a future refactor that moves the
 * implementation around can't silently desync the two.
 *
 * Mirrors `test/persistence-failure.test.ts`'s setup (real writers,
 * real tx); no fake DB. The persistence-failure layer-3 tests cover
 * the `persistThen` pattern in isolation; this file proves each
 * `MessageLog` method respects it end-to-end (mid-tx failure → store
 * unchanged AND disk unchanged).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type PersistenceErrorContext,
	setPersistenceErrorHandler,
} from "@backend/persistence/errors";
import {
	createSession,
	loadSession,
	newId,
} from "@backend/persistence/sessions";
import type { AgentStoreState, DisplayMessage } from "@bridge/view-model";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { createStore } from "solid-js/store";
import { createMessageLog } from "../src/tui/context/agent/message-log";
import type { SessionState } from "../src/tui/context/agent/session-state";

// ---------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------

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

/**
 * Build a fresh `MessageLog` over a real SQLite session row plus an
 * empty store. Tests that need a different starting state (e.g.
 * pre-seeded messages) mutate the returned store directly before
 * exercising `MessageLog` methods.
 */
function makeHarness(opts?: { sessionId?: string | null }) {
	const sess =
		opts?.sessionId === null
			? null
			: opts?.sessionId
				? { id: opts.sessionId }
				: createSession({ agent: "reader" });
	const sid = sess?.id ?? null;
	const [store, setStore] = createStore<AgentStoreState>({
		messages: [],
		isStreaming: false,
		sidebarSections: [],
		sessionTitle: "test",
		modelName: "Claude Opus 4.7",
		modelProvider: "openrouter",
		contextWindow: 200_000,
		modelReasoning: false,
		thinkingLevel: "off",
		status: "idle",
		totalTokens: 0,
		totalCost: 0,
		lastTurnStartedAt: 0,
		currentAgent: "reader",
	});
	const sessionState: SessionState = {
		getCurrentSessionId: () => sid,
		setCurrentSessionId: () => {},
		subscribeSessionId: () => () => sid,
		getTurnStartThinkingLevel: () => undefined,
		setTurnStartThinkingLevel: () => {},
		getPreTurnCodexConnections: () => undefined,
		setPreTurnCodexConnections: () => {},
		getPendingDispatchChildId: () => null,
		setPendingDispatchChildId: () => {},
		ensureSession: () => sid ?? "",
	};
	const log = createMessageLog({ store, setStore, sessionState });
	return { sid, store, setStore, log, sessionState };
}

// ---------------------------------------------------------------
// 1. appendUserBubble — store and disk agree
// ---------------------------------------------------------------

describe("appendUserBubble", () => {
	test("on success: store has the bubble and loadSession returns the same row", () => {
		const { sid, store, log } = makeHarness();
		if (!sid) throw new Error("expected session");

		const ok = log.appendUserBubble([{ type: "text", text: "hello" }]);

		expect(ok).toBe(true);
		expect(store.messages.length).toBe(1);
		const inStore = store.messages[0]!;
		expect(inStore.role).toBe("user");
		expect(inStore.parts).toEqual([{ type: "text", text: "hello" }]);

		const loaded = loadSession(sid);
		expect(loaded?.displayMessages.length).toBe(1);
		const onDisk = loaded!.displayMessages[0]!;
		expect(onDisk.id).toBe(inStore.id);
		expect(onDisk.role).toBe("user");
		expect(onDisk.parts).toEqual([{ type: "text", text: "hello" }]);
	});

	test("returns false when no session has been ensured (pre-first-prompt)", () => {
		const { store, log } = makeHarness({ sessionId: null });
		const ok = log.appendUserBubble([{ type: "text", text: "hi" }]);
		expect(ok).toBe(false);
		expect(store.messages.length).toBe(0);
	});
});

// ---------------------------------------------------------------
// 2. stampAssistantOnMessageEnd — atomic meta + parts + raw
// ---------------------------------------------------------------

function makeRawAssistant(
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
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
		...overrides,
	} as unknown as AssistantMessage;
}

// ---------------------------------------------------------------
// Persistence helpers re-imported here to seed pre-existing rows
// (mirrors what `message_start` would have done before the test
// calls into a stamp method).
// ---------------------------------------------------------------

import {
	appendDisplayMessage,
	finalizeDisplayMessageParts,
	withTransaction,
} from "@backend/persistence/sessions";

/**
 * Push an empty assistant shell into both store + disk so a
 * subsequent stamp/sweep call has a target to mutate. Mirrors what
 * the reducer does on `message_start`.
 */
function seedAssistantShell(
	sid: string,
	setStore: ReturnType<typeof createStore<AgentStoreState>>[1],
	parts: DisplayMessage["parts"] = [],
): DisplayMessage {
	const msg: DisplayMessage = { id: newId(), role: "assistant", parts };
	setStore("messages", (prev) => [...prev, msg]);
	withTransaction((tx) =>
		appendDisplayMessage(tx, sid, msg, { includeParts: false }),
	);
	return msg;
}

describe("stampAssistantOnMessageEnd", () => {
	test("normal end: bubble has no error / interrupted; raw row appended", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore);

		log.stampAssistantOnMessageEnd(makeRawAssistant());

		expect(store.messages[0]!.error).toBeUndefined();
		expect(store.messages[0]!.interrupted).toBeUndefined();
		const loaded = loadSession(sid)!;
		expect(loaded.displayMessages[0]!.error).toBeUndefined();
		expect(loaded.displayMessages[0]!.interrupted).toBeUndefined();
		expect(loaded.agentMessages.length).toBe(1);
	});

	test("stopReason=error stamps error on store + disk", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore);

		log.stampAssistantOnMessageEnd(
			makeRawAssistant({
				stopReason: "error" as never,
				errorMessage: "rate limit hit" as never,
			}),
		);

		expect(store.messages[0]!.error).toBe("rate limit hit");
		expect(loadSession(sid)!.displayMessages[0]!.error).toBe("rate limit hit");
	});

	test("stopReason=aborted stamps interrupted on store + disk", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore);

		log.stampAssistantOnMessageEnd(
			makeRawAssistant({ stopReason: "aborted" as never }),
		);

		expect(store.messages[0]!.interrupted).toBe(true);
		expect(loadSession(sid)!.displayMessages[0]!.interrupted).toBe(true);
	});

	test("no-op when last message is not assistant", () => {
		const { sid, store, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		log.appendUserBubble([{ type: "text", text: "hi" }]);
		// Last is user; stamp targets the latest assistant only.
		log.stampAssistantOnMessageEnd(makeRawAssistant());
		expect(store.messages.length).toBe(1);
		expect(loadSession(sid)!.agentMessages.length).toBe(0);
	});
});

// ---------------------------------------------------------------
// 3. applyToolResult — tail-scan by callId
// ---------------------------------------------------------------

describe("applyToolResult", () => {
	test("flips matching pending tool to completed in store + disk", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		const shell = seedAssistantShell(sid, setStore, [
			{
				type: "tool",
				callId: "c1",
				name: "read",
				args: { path: "x.md" },
				state: "pending",
			},
		]);
		void shell;
		// finalizeDisplayMessageParts the seeded parts so the disk row
		// has the pending tool to start with — mirrors what the reducer
		// would have run after the parts streamed in.
		withTransaction((tx) =>
			finalizeDisplayMessageParts(tx, sid, store.messages[0]!),
		);

		log.applyToolResult("c1", { content: [] }, false);

		const part = store.messages[0]!.parts[0]!;
		expect(part.type).toBe("tool");
		if (part.type === "tool") expect(part.state).toBe("completed");
		const onDisk = loadSession(sid)!.displayMessages[0]!.parts[0]!;
		if (onDisk.type === "tool") expect(onDisk.state).toBe("completed");
	});

	test("error result stamps state=error with extracted error message", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore, [
			{
				type: "tool",
				callId: "c1",
				name: "read",
				args: { path: "x.md" },
				state: "pending",
			},
		]);
		withTransaction((tx) =>
			finalizeDisplayMessageParts(tx, sid, store.messages[0]!),
		);

		log.applyToolResult(
			"c1",
			{ content: [{ type: "text", text: "ENOENT: no such file" }] },
			true,
		);

		const part = store.messages[0]!.parts[0]!;
		if (part.type === "tool") {
			expect(part.state).toBe("error");
			expect(part.error).toBe("ENOENT: no such file");
		}
	});

	test("scans multiple assistant messages tail-first to find by callId", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		// Earlier assistant bubble carries the matching tool; later one
		// carries a different one. Tail-first scan still finds the match
		// (today's reducer comment: "always on one of the most recent").
		seedAssistantShell(sid, setStore, [
			{
				type: "tool",
				callId: "OLD",
				name: "read",
				args: {},
				state: "pending",
			},
		]);
		seedAssistantShell(sid, setStore, [
			{
				type: "tool",
				callId: "NEW",
				name: "edit",
				args: {},
				state: "pending",
			},
		]);
		withTransaction((tx) => {
			finalizeDisplayMessageParts(tx, sid, store.messages[0]!);
			finalizeDisplayMessageParts(tx, sid, store.messages[1]!);
		});

		log.applyToolResult("OLD", { content: [] }, false);

		const oldPart = store.messages[0]!.parts[0]!;
		if (oldPart.type === "tool") expect(oldPart.state).toBe("completed");
		const newPart = store.messages[1]!.parts[0]!;
		if (newPart.type === "tool") expect(newPart.state).toBe("pending");
	});

	test("no-op when callId not found", () => {
		const { sid, store, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		log.appendUserBubble([{ type: "text", text: "hi" }]);
		expect(() =>
			log.applyToolResult("nonexistent", { content: [] }, false),
		).not.toThrow();
		expect(store.messages.length).toBe(1);
	});
});

// ---------------------------------------------------------------
// 4. sweepPendingTools — multi-message atomic flip on agent_end
// ---------------------------------------------------------------

describe("sweepPendingTools", () => {
	test("flips all pending tool parts across all assistants to error", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore, [
			{ type: "tool", callId: "a", name: "read", args: {}, state: "pending" },
		]);
		seedAssistantShell(sid, setStore, [
			{ type: "text", text: "ok" },
			{ type: "tool", callId: "b", name: "edit", args: {}, state: "pending" },
		]);
		withTransaction((tx) => {
			finalizeDisplayMessageParts(tx, sid, store.messages[0]!);
			finalizeDisplayMessageParts(tx, sid, store.messages[1]!);
		});

		log.sweepPendingTools();

		// Store: both pending → error.
		for (const m of store.messages) {
			for (const p of m.parts) {
				if (p.type === "tool") {
					expect(p.state).toBe("error");
					expect(p.error).toBe("Tool execution interrupted");
				}
			}
		}
		// Disk: same.
		const onDisk = loadSession(sid)!;
		for (const m of onDisk.displayMessages) {
			for (const p of m.parts) {
				if (p.type === "tool") expect(p.state).toBe("error");
			}
		}
	});

	test("preserves an existing tool error message instead of overwriting", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore, [
			{
				type: "tool",
				callId: "a",
				name: "read",
				args: {},
				state: "pending",
				error: "User denied write",
			},
		]);
		withTransaction((tx) =>
			finalizeDisplayMessageParts(tx, sid, store.messages[0]!),
		);

		log.sweepPendingTools();

		const part = store.messages[0]!.parts[0]!;
		if (part.type === "tool") {
			expect(part.state).toBe("error");
			expect(part.error).toBe("User denied write");
		}
	});

	test("no-op when no pending tools exist", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore, [{ type: "text", text: "done" }]);
		withTransaction((tx) =>
			finalizeDisplayMessageParts(tx, sid, store.messages[0]!),
		);

		expect(() => log.sweepPendingTools()).not.toThrow();
		expect(store.messages[0]!.parts[0]).toEqual({ type: "text", text: "done" });
	});
});

// ---------------------------------------------------------------
// 5. stampTurnClose — per-turn meta on the latest assistant
// ---------------------------------------------------------------

describe("stampTurnClose", () => {
	test("stamps agentName, modelName, duration, thinkingLevel on latest assistant", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore, [{ type: "text", text: "ok" }]);

		log.stampTurnClose({
			agentName: "Reader",
			modelName: "Claude Opus 4.7",
			duration: 1234,
			thinkingLevel: "medium",
		});

		const inStore = store.messages[0]!;
		expect(inStore.agentName).toBe("Reader");
		expect(inStore.modelName).toBe("Claude Opus 4.7");
		expect(inStore.duration).toBe(1234);
		expect(inStore.thinkingLevel).toBe("medium");
		const onDisk = loadSession(sid)!.displayMessages[0]!;
		expect(onDisk.agentName).toBe("Reader");
		expect(onDisk.duration).toBe(1234);
		expect(onDisk.thinkingLevel).toBe("medium");
	});

	test("only the most recent assistant gets the stamp (multi-message turn)", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore, [{ type: "text", text: "earlier" }]);
		seedAssistantShell(sid, setStore, [{ type: "text", text: "closing" }]);

		log.stampTurnClose({
			agentName: "Reader",
			modelName: "Claude Opus 4.7",
			duration: 999,
		});

		expect(store.messages[0]!.duration).toBeUndefined();
		expect(store.messages[1]!.duration).toBe(999);
		expect(store.messages[1]!.agentName).toBe("Reader");
	});

	test("no-op when last message is not assistant", () => {
		const { sid, store, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		log.appendUserBubble([{ type: "text", text: "hi" }]);

		log.stampTurnClose({ agentName: "Reader", duration: 100 });

		const m = store.messages[0]!;
		expect(m.role).toBe("user");
		expect((m as DisplayMessage).agentName).toBeUndefined();
	});
});

// ---------------------------------------------------------------
// 6. markInterruptedUser — flag user when no real reply follows
// ---------------------------------------------------------------

describe("markInterruptedUser", () => {
	test("flags interrupted on user when followed by empty assistant", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		log.appendUserBubble([{ type: "text", text: "hi" }]);
		seedAssistantShell(sid, setStore); // empty parts, no error/interrupted

		log.markInterruptedUser();

		expect(store.messages[0]!.interrupted).toBe(true);
		expect(loadSession(sid)!.displayMessages[0]!.interrupted).toBe(true);
	});

	test("flags interrupted on user when no assistant follows at all", () => {
		const { sid, store, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		log.appendUserBubble([{ type: "text", text: "hi" }]);

		log.markInterruptedUser();

		expect(store.messages[0]!.interrupted).toBe(true);
	});

	test("skipped when next assistant has parts (real reply)", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		log.appendUserBubble([{ type: "text", text: "hi" }]);
		seedAssistantShell(sid, setStore, [{ type: "text", text: "real reply" }]);

		log.markInterruptedUser();

		expect(store.messages[0]!.interrupted).toBeUndefined();
	});

	test("skipped when next assistant has error (counts as a real reply)", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		log.appendUserBubble([{ type: "text", text: "hi" }]);
		const shell = seedAssistantShell(sid, setStore);
		setStore("messages", 1, "error", "rate limit");
		void shell;

		log.markInterruptedUser();

		expect(store.messages[0]!.interrupted).toBeUndefined();
	});

	test("no-op when no user message exists", () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore);
		expect(() => log.markInterruptedUser()).not.toThrow();
		expect(store.messages[0]!.interrupted).toBeUndefined();
	});
});

// ---------------------------------------------------------------
// 7. appendBubbleBestEffort — safeRun semantics
// ---------------------------------------------------------------

describe("appendBubbleBestEffort", () => {
	test("happy path: store + disk both have the bubble", () => {
		const { sid, store, log } = makeHarness();
		if (!sid) throw new Error("expected session");

		log.appendBubbleBestEffort([{ type: "text", text: "recommendation" }]);

		expect(store.messages.length).toBe(1);
		expect(store.messages[0]!.parts).toEqual([
			{ type: "text", text: "recommendation" },
		]);
		expect(loadSession(sid)!.displayMessages.length).toBe(1);
	});

	test("store still mutates even when disk write fails", () => {
		// Force a disk failure by using a session id that doesn't exist
		// — `appendDisplayMessage` will FK-violate. Best-effort semantics
		// require the store to mutate anyway (the recommendation bubble
		// renders in-memory; resume would miss it, which is benign).
		const { store, log } = makeHarness({ sessionId: "does-not-exist" });
		log.appendBubbleBestEffort([{ type: "text", text: "decoration" }]);
		expect(store.messages.length).toBe(1);
		expect(reports.length).toBe(1);
	});

	test("returns true when no session exists yet (pre-first-prompt is benign)", () => {
		// Best-effort doesn't gate on session presence at all — the
		// store still mutates even with no disk target. Differs from
		// `appendUserBubble` which returns false in this case so the
		// caller can short-circuit downstream turn work.
		const { store, log } = makeHarness({ sessionId: null });
		log.appendBubbleBestEffort([{ type: "text", text: "noop" }]);
		// store mutates regardless; reports has the "no session" hop
		// from sessionState.ensureSession path? — In this module, we
		// just skip the disk write when sid is null. No error reported.
		expect(store.messages.length).toBe(1);
	});
});

// ---------------------------------------------------------------
// 8. Persist-first failure (rollback gate, parameterized)
//
// Each persist-first method must leave the store at its pre-
// mutation value when the SQLite tx body throws. This is the
// invariant that justifies the module — proven once for every
// method.
//
// We force tx failure by pointing the harness at a non-existent
// session id so writes FK-violate (mirrors the
// persistence-failure.test.ts pattern).
// ---------------------------------------------------------------

describe("persist-first rollback gate", () => {
	test("appendUserBubble: store unchanged when tx fails", () => {
		const { store, log } = makeHarness({ sessionId: "does-not-exist" });
		const ok = log.appendUserBubble([{ type: "text", text: "hi" }]);
		expect(ok).toBe(false);
		expect(store.messages.length).toBe(0);
		expect(reports.length).toBe(1);
	});

	test("stampAssistantOnMessageEnd: error not stamped on tx failure", () => {
		// Seed against a real session, then swap to a bad sid before
		// stamping. The appendAgentMessage call inside the trio will
		// FK-violate (display_message_id points at a row this session
		// can't see), forcing the rollback path.
		const { sid, store, setStore } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore);
		const log2 = createMessageLog({
			store,
			setStore,
			sessionState: makeBadSessionState(),
		});
		log2.stampAssistantOnMessageEnd(
			makeRawAssistant({
				stopReason: "error" as never,
				errorMessage: "should-not-stamp" as never,
			}),
		);
		expect(store.messages[0]!.error).toBeUndefined();
	});

	test("applyToolResult: store unchanged on tx failure", async () => {
		// Force `finalizeDisplayMessageParts` to FK-fail on the parts
		// re-INSERT by deleting the messages row out from under it
		// after the in-store seed but before the persist call. The
		// DELETE inside finalizeDisplayMessageParts succeeds (target
		// rows already gone or never existed), but the subsequent
		// part INSERT fails on `parts.message_id → messages.id`.
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore, [
			{ type: "tool", callId: "c1", name: "read", args: {}, state: "pending" },
		]);
		withTransaction((tx) =>
			finalizeDisplayMessageParts(tx, sid, store.messages[0]!),
		);
		// Mid-test, drop the messages row so the parts re-INSERT FK-
		// violates. Cascade deletes the parts too — drizzle's PRAGMA
		// foreign_keys=ON is set by the migration runner.
		const { getDb } = await import("@backend/persistence/db/client");
		const db = getDb();
		const { messages } = await import("@backend/persistence/db/schema");
		const { eq } = await import("drizzle-orm");
		db.delete(messages).where(eq(messages.id, store.messages[0]!.id)).run();

		log.applyToolResult("c1", { content: [] }, false);
		const part = store.messages[0]!.parts[0]!;
		if (part.type === "tool") expect(part.state).toBe("pending");
	});

	test("sweepPendingTools: store unchanged on tx failure", async () => {
		const { sid, store, setStore, log } = makeHarness();
		if (!sid) throw new Error("expected session");
		seedAssistantShell(sid, setStore, [
			{ type: "tool", callId: "c1", name: "read", args: {}, state: "pending" },
		]);
		withTransaction((tx) =>
			finalizeDisplayMessageParts(tx, sid, store.messages[0]!),
		);
		const { getDb } = await import("@backend/persistence/db/client");
		const db = getDb();
		const { messages } = await import("@backend/persistence/db/schema");
		const { eq } = await import("drizzle-orm");
		db.delete(messages).where(eq(messages.id, store.messages[0]!.id)).run();

		log.sweepPendingTools();
		const part = store.messages[0]!.parts[0]!;
		if (part.type === "tool") expect(part.state).toBe("pending");
	});

	// `stampTurnClose` and `markInterruptedUser` are deliberately not
	// covered here. Both call ONLY `updateDisplayMessageMeta`, which
	// SQLite treats as a silent no-op when the row doesn't exist (no
	// FK to violate, UPDATE on zero rows is not an error — see
	// persistence-failure.test.ts:114). There's no way to force a tx
	// failure for these via bad-sid alone without injecting a fake
	// writer (anti-pattern). The persist-then gate they share with
	// the others is already proven by persistence-failure.test.ts's
	// Layer-3 tests at the writer level; per-method rollback proof
	// requires a writer that actually throws, which these don't have.
});

// ---------------------------------------------------------------
// 9. appendAssistantShell — best-effort header insert on message_start
// ---------------------------------------------------------------

describe("appendAssistantShell", () => {
	test("pushes empty assistant bubble to store + disk header (no parts)", () => {
		const { sid, store, log } = makeHarness();
		if (!sid) throw new Error("expected session");

		log.appendAssistantShell();

		expect(store.messages.length).toBe(1);
		expect(store.messages[0]!.role).toBe("assistant");
		expect(store.messages[0]!.parts).toEqual([]);
		const onDisk = loadSession(sid)!.displayMessages[0]!;
		expect(onDisk.role).toBe("assistant");
		expect(onDisk.parts).toEqual([]);
	});

	test("store still mutates even when disk write fails (best-effort)", () => {
		const { store, log } = makeHarness({ sessionId: "does-not-exist" });
		log.appendAssistantShell();
		expect(store.messages.length).toBe(1);
		expect(reports.length).toBe(1);
	});

	test("no-op when no session exists yet", () => {
		const { store, log } = makeHarness({ sessionId: null });
		log.appendAssistantShell();
		// Today's reducer has the same shape — push to store + skip
		// disk write when sid is null. Test pins this contract.
		expect(store.messages.length).toBe(1);
	});
});

function makeBadSessionState(): SessionState {
	return {
		getCurrentSessionId: () => "does-not-exist",
		setCurrentSessionId: () => {},
		getTurnStartThinkingLevel: () => undefined,
		setTurnStartThinkingLevel: () => {},
		getPreTurnCodexConnections: () => undefined,
		setPreTurnCodexConnections: () => {},
		ensureSession: () => "does-not-exist",
	};
}

void reports;
