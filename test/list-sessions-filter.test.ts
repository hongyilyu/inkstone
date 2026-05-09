/**
 * `listSessions` excludes router sessions.
 *
 * Per the routing design (grilling Q16) and ADR 0007, router sessions
 * are backend infrastructure — they exist on disk so child sessions
 * have a `parent_session_id` FK target and the dispatch tool-call has
 * somewhere to live, but they are never user-facing. The sessions list
 * filter enforces this.
 *
 * After PR 5 lands routerAgent in the registry, every routing fork
 * creates a router session. Without the filter, every freeform open-
 * page submit doubles the visible row count.
 */
import { describe, expect, test } from "bun:test";
import {
	createSession,
	forkSession,
	listSessions,
	newId,
} from "@backend/persistence/sessions";
import "./preload";

describe("listSessions filter", () => {
	test("router sessions are hidden; their reader/kb children remain visible", () => {
		const router = createSession({ agent: "router" });
		const child = forkSession({
			parentId: router.id,
			targetAgent: "reader",
			seedMessages: [
				{
					display: {
						id: newId(),
						role: "user",
						parts: [{ type: "text", text: "fixture-router-filter" }],
					},
				},
			],
		});

		const list = listSessions();
		const ids = list.map((s) => s.id);
		expect(ids).not.toContain(router.id);
		expect(ids).toContain(child.id);
	});

	test("non-router sessions remain visible regardless of parentSessionId", () => {
		// A user-initiated fork (future feature) where the parent is
		// Reader — the parent must NOT be hidden because it's a real
		// user-facing session, only the *router* role triggers hiding.
		const reader = createSession({ agent: "reader" });
		const list = listSessions();
		const ids = list.map((s) => s.id);
		expect(ids).toContain(reader.id);
	});
});
