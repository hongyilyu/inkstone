/**
 * `sessions.parent_session_id` column round-trip.
 *
 * The column is set by `forkSession()` (PR 3) when a child session is
 * born from a parent. This test verifies the column is part of the
 * schema, accepts inserts via the drizzle client, and round-trips
 * through `loadSession` so the field is visible to TUI consumers
 * (e.g. for sessions-list filtering in PR 6).
 *
 * Per ADR 0014 the FK is nullable — `createSession` callers leave it
 * NULL because they're not forking. Only `forkSession` sets it.
 */
import { describe, expect, test } from "bun:test";
import { getDb } from "@backend/persistence/db/client";
import { sessions } from "@backend/persistence/db/schema";
import { createSession, loadSession } from "@backend/persistence/sessions";
import { eq } from "drizzle-orm";
import "./preload";

describe("sessions.parent_session_id", () => {
	test("createSession leaves parentSessionId NULL", () => {
		const rec = createSession({ agent: "reader" });
		const loaded = loadSession(rec.id);
		expect(loaded?.session.parentSessionId).toBeNull();
	});

	test("parentSessionId set via direct update round-trips through loadSession", () => {
		const parent = createSession({ agent: "router" });
		const child = createSession({ agent: "reader" });
		const db = getDb();
		db.update(sessions)
			.set({ parentSessionId: parent.id })
			.where(eq(sessions.id, child.id))
			.run();

		const loaded = loadSession(child.id);
		expect(loaded?.session.parentSessionId).toBe(parent.id);
	});
});
