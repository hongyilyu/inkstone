/**
 * File-part display round-trip through the persistence layer.
 *
 * The regression this guards: reader's `/article` emits a compact user
 * bubble — `[text "Read this article.", file text/markdown <path>]` —
 * and the LLM-facing prompt text is the full article body. The bubble
 * and the prompt text are split inside `wrappedActions.prompt`: pi-
 * agent-core only sees the text; the Solid store gets the `displayParts`.
 *
 * When a session like that is saved and resumed, the bubble must render
 * identically to the fresh run. Since this test runs below the TUI
 * layer, we verify the persistence round-trip directly: write a user
 * `DisplayMessage` with `[text, file]` parts, load the session back,
 * assert the `displayMessages` out of `loadSession` match byte-for-byte.
 *
 * Also exercises `listSessions`'s preview fallback: when the first user
 * message has no text body, the preview should surface the first file
 * part's filename so the session list panel has something meaningful
 * to show.
 */

import { describe, expect, test } from "bun:test";
import {
	appendDisplayMessage,
	createSession,
	listSessions,
	loadSession,
	newId,
	runInTransaction,
} from "@backend/persistence/sessions";
import type { DisplayMessage } from "@bridge/view-model";
import "./preload";

describe("display parts — file round-trip", () => {
	test("text + file parts persist and hydrate identically", () => {
		const rec = createSession({ agent: "reader" });
		const msg: DisplayMessage = {
			id: newId(),
			role: "user",
			parts: [
				{ type: "text", text: "Read this article." },
				{
					type: "file",
					mime: "text/markdown",
					filename: "010 RAW/013 Articles/foo.md",
				},
			],
		};
		runInTransaction((tx) => appendDisplayMessage(tx, rec.id, msg));

		const loaded = loadSession(rec.id);
		expect(loaded).not.toBeNull();
		expect(loaded!.displayMessages.length).toBe(1);
		const got = loaded!.displayMessages[0];
		expect(got).toBeDefined();
		expect(got!.role).toBe("user");
		expect(got!.parts).toEqual(msg.parts);
	});

	test("listSessions preview falls back to first file filename", () => {
		// A display-only file bubble — no text parts at all. Stresses
		// the preview's "text preview empty → use filename" branch.
		const rec = createSession({ agent: "reader" });
		const msg: DisplayMessage = {
			id: newId(),
			role: "user",
			parts: [
				{
					type: "file",
					mime: "text/markdown",
					filename: "010 RAW/013 Articles/only.md",
				},
			],
		};
		runInTransaction((tx) => appendDisplayMessage(tx, rec.id, msg));

		const summaries = listSessions();
		const found = summaries.find((s) => s.id === rec.id);
		expect(found).toBeDefined();
		expect(found!.preview).toBe("010 RAW/013 Articles/only.md");
	});

	test("listSessions preview prefers text over filename when both exist", () => {
		const rec = createSession({ agent: "reader" });
		const msg: DisplayMessage = {
			id: newId(),
			role: "user",
			parts: [
				{ type: "text", text: "Read this article." },
				{
					type: "file",
					mime: "text/markdown",
					filename: "010 RAW/013 Articles/bar.md",
				},
			],
		};
		runInTransaction((tx) => appendDisplayMessage(tx, rec.id, msg));

		const summaries = listSessions();
		const found = summaries.find((s) => s.id === rec.id);
		expect(found).toBeDefined();
		expect(found!.preview).toBe("Read this article.");
	});

	test("thinkingLevel round-trips through loadSession when set", () => {
		// Pins the persistence read path for the per-turn reasoning-effort
		// stamp. Writer: `appendDisplayMessage` carries
		// `thinkingLevel: msg.thinkingLevel ?? null` into the row; reader:
		// `loadSession` casts the opaque TEXT column through
		// `ThinkingLevel | null` into the DisplayMessage. Without this
		// pin, dropping either side would be invisible to the reducer/
		// renderer tests in `test/tui/streaming.test.tsx`.
		const rec = createSession({ agent: "reader" });
		const msg: DisplayMessage = {
			id: newId(),
			role: "assistant",
			parts: [{ type: "text", text: "ok" }],
			agentName: "Reader",
			modelName: "Claude Test",
			duration: 1234,
			thinkingLevel: "high",
		};
		runInTransaction((tx) => appendDisplayMessage(tx, rec.id, msg));

		const loaded = loadSession(rec.id);
		expect(loaded).not.toBeNull();
		const got = loaded!.displayMessages[0];
		expect(got).toBeDefined();
		expect(got!.thinkingLevel).toBe("high");
	});

	test("absent thinkingLevel loads as undefined (pre-stamping bubble shape)", () => {
		// Bubbles persisted before the per-message effort stamp existed
		// have no `thinking_level` value. On load they must surface as
		// `undefined`, so the renderer's `<Show when={msg().thinkingLevel
		// && msg().thinkingLevel !== "off"}>` guard hides the badge
		// without tripping on a null/undefined boundary.
		const rec = createSession({ agent: "reader" });
		const msg: DisplayMessage = {
			id: newId(),
			role: "assistant",
			parts: [{ type: "text", text: "pre-stamp" }],
			agentName: "Reader",
			modelName: "Claude Test",
			duration: 500,
		};
		runInTransaction((tx) => appendDisplayMessage(tx, rec.id, msg));

		const loaded = loadSession(rec.id);
		expect(loaded).not.toBeNull();
		const got = loaded!.displayMessages[0];
		expect(got).toBeDefined();
		expect(got!.thinkingLevel).toBeUndefined();
	});
});
