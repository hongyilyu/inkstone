/**
 * Fork-part discriminant round-trip.
 *
 * Verifies the new `parts.type = "fork"` row shape persists and reconstructs
 * cleanly through `appendDisplayMessage` (serializer) and `loadSession`
 * (deserializer). The fork-marker payload (`parentSessionId`) lives in the
 * `tool_data` JSON column — reusing the existing nullable JSON sidecar
 * rather than adding a new column.
 *
 * Per ADR 0015, the fork part is a category distinct from `tool` so any
 * code that walks `parts` filtering on `type === "tool"` cannot accidentally
 * sweep up routing artifacts. This test pins the round-trip but does NOT
 * assert anything about TUI rendering — that is PR 4's concern.
 */
import { describe, expect, test } from "bun:test";
import { getDb } from "@backend/persistence/db/client";
import { messages, parts } from "@backend/persistence/db/schema";
import {
	appendDisplayMessage,
	createSession,
	loadSession,
	newId,
	withTransaction,
} from "@backend/persistence/sessions";
import type { DisplayMessage } from "@bridge/view-model";
import "./preload";

describe("fork part round-trip", () => {
	test("fork-typed display part survives serialize → deserialize", () => {
		const parent = createSession({ agent: "router" });
		const child = createSession({ agent: "reader" });

		const forkMarker: DisplayMessage = {
			id: Bun.randomUUIDv7(),
			role: "assistant",
			parts: [
				{ type: "fork", parentSessionId: parent.id, targetAgent: "reader" },
			],
		};

		withTransaction((tx) => {
			appendDisplayMessage(tx, child.id, forkMarker);
		});

		const loaded = loadSession(child.id);
		expect(loaded).not.toBeNull();
		expect(loaded?.displayMessages.length).toBe(1);

		const part = loaded?.displayMessages[0]?.parts[0];
		expect(part).toEqual({
			type: "fork",
			parentSessionId: parent.id,
			targetAgent: "reader",
		});
	});

	test.each([
		["primitive string", "oops"],
		["primitive number", 42],
		["array", ["not", "an", "object"]],
		["null", null],
	])("corrupt tool_data (%s) on a fork row degrades to empty text instead of crashing loadSession", (_label, corrupt) => {
		// `tool_data` is a JSON column with no runtime schema validation.
		// A row written by a future buggy migration / direct SQL / pi-
		// agent-core widening could hold any JSON-encodable value. The
		// `"parentSessionId" in row.toolData` guard throws TypeError on
		// primitives — without `isToolDataObject`, a single bad row
		// crashes the whole `loadSession` call (and every dependent
		// `listSessions` preview).
		const sess = createSession({ agent: "reader" });
		const db = getDb();
		const messageRow = newId();
		db.insert(messages)
			.values({
				id: messageRow,
				sessionId: sess.id,
				role: "assistant",
				createdAt: Date.now(),
			})
			.run();
		db.insert(parts)
			.values({
				messageId: messageRow,
				seq: 0,
				type: "fork",
				text: "",
				mime: null,
				filename: null,
				callId: null,
				// biome-ignore lint/suspicious/noExplicitAny: deliberately corrupt
				toolData: corrupt as any,
			})
			.run();

		// Must NOT throw. The reporter logs an error, the row
		// degrades to `{ type: "text", text: "" }`, and the rest of
		// the session loads cleanly.
		expect(() => loadSession(sess.id)).not.toThrow();
		const loaded = loadSession(sess.id);
		expect(loaded?.displayMessages.length).toBe(1);
		expect(loaded?.displayMessages[0]?.parts[0]).toEqual({
			type: "text",
			text: "",
		});
	});
});
