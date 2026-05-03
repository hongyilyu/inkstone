import { describe, expect, test } from "bun:test";
import { Config } from "@backend/persistence/schema";
import {
	appendDisplayMessage,
	createDefaultTitle,
	createSession,
	listSessions,
	loadSession,
	newId,
	runInTransaction,
	updateSessionTitle,
} from "@backend/persistence/sessions";
import { cleanSessionTitle } from "../src/backend/agent/session-title";

describe("session titles", () => {
	test("createSession initializes title to a human-readable default", () => {
		const rec = createSession({ agent: "reader" });
		expect(rec.title).toMatch(/^New session - \d{4}-\d{2}-\d{2}T/);

		const loaded = loadSession(rec.id);
		expect(loaded?.session.title).toBe(rec.title);
	});

	test("createDefaultTitle produces ISO-timestamped string", () => {
		const ts = new Date("2026-05-02T12:00:00.000Z").getTime();
		expect(createDefaultTitle(ts)).toBe(
			"New session - 2026-05-02T12:00:00.000Z",
		);
	});

	test("updateSessionTitle replaces the stored session title", () => {
		const rec = createSession({ agent: "reader" });

		runInTransaction((tx) => updateSessionTitle(tx, rec.id, "Reading Notes"));

		const loaded = loadSession(rec.id);
		expect(loaded?.session.title).toBe("Reading Notes");
	});

	test("listSessions returns title and still computes preview", () => {
		const rec = createSession({ agent: "reader" });
		runInTransaction((tx) => {
			appendDisplayMessage(tx, rec.id, {
				id: newId(),
				role: "user",
				parts: [{ type: "text", text: "first user preview" }],
			});
			updateSessionTitle(tx, rec.id, "Generated Title");
		});

		const row = listSessions().find((s) => s.id === rec.id);
		expect(row?.title).toBe("Generated Title");
		expect(row?.preview).toBe("first user preview");
	});

	test("cleans generated title output", () => {
		expect(cleanSessionTitle('"Useful title"\nextra')).toBe("Useful title");
		expect(cleanSessionTitle("<think>hidden</think>\nVisible")).toBe("Visible");
		expect(cleanSessionTitle("\n\n")).toBeNull();
		expect(cleanSessionTitle("a".repeat(60))).toBe("a".repeat(50));
	});

	test("config schema validates sessionTitleModel shape", () => {
		expect(
			Config.safeParse({
				sessionTitleModel: { providerId: "openrouter", modelId: "kimi" },
			}).success,
		).toBe(true);
		expect(
			Config.safeParse({
				sessionTitleModel: { providerId: "", modelId: "kimi" },
			}).success,
		).toBe(false);
		expect(
			Config.safeParse({
				sessionTitleModel: { providerId: "openrouter" },
			}).success,
		).toBe(false);
	});
});
