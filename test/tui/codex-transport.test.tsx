/**
 * Codex transport detection + statusline indicator.
 *
 * pi-ai 0.72.x's Codex provider defaults `transport: "auto"` — tries
 * WebSocket first (with `websocket-cached` continuation on subsequent
 * turns), silently falls back to SSE on connection failure. Inkstone
 * opts into that default explicitly via `Agent({ transport: "auto" })`
 * and surfaces the transport choice on the prompt statusline via a
 * muted `· ws` / `· sse` suffix next to the model name.
 *
 * Detection: diff `getOpenAICodexWebSocketDebugStats(sessionId)` around
 * each Codex turn. pi-ai's WebSocket counter
 * (`connectionsCreated + connectionsReused`) advances only when
 * `processWebSocketStream` reaches the body-request step. Unchanged
 * counter → SSE path used. Writes to `store.codexTransport`; never
 * persisted to SQLite or stamped onto `DisplayMessage`.
 *
 * Strategy: mock `@mariozechner/pi-ai/openai-codex-responses` so
 * `getOpenAICodexWebSocketDebugStats` returns whatever the test
 * scripts. Run synthetic turns through the fake session and assert on
 * the rendered statusline suffix.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Api as PiApi, Model as PiModel } from "@mariozechner/pi-ai";

// Stats table keyed by sessionId — mutated by tests, read by
// `getOpenAICodexWebSocketDebugStats`.
type Stats = { connectionsCreated: number; connectionsReused: number };
const statsBySession = new Map<string, Stats>();

mock.module("@mariozechner/pi-ai/openai-codex-responses", () => ({
	getOpenAICodexWebSocketDebugStats: (sessionId: string) => {
		return statsBySession.get(sessionId);
	},
	resetOpenAICodexWebSocketDebugStats: (sessionId?: string) => {
		if (sessionId) statsBySession.delete(sessionId);
		else statsBySession.clear();
	},
	closeOpenAICodexWebSocketSessions: (sessionId?: string) => {
		if (sessionId) statsBySession.delete(sessionId);
		else statsBySession.clear();
	},
	streamOpenAICodexResponses: () => {
		throw new Error(
			"streamOpenAICodexResponses should not be called from the reducer test",
		);
	},
	streamSimpleOpenAICodexResponses: () => {
		throw new Error(
			"streamSimpleOpenAICodexResponses should not be called from the reducer test",
		);
	},
}));

// Imports after mock.module so agent.tsx resolves through the stub.
const {
	assistantMessage,
	ev_agentEnd,
	ev_agentStart,
	ev_messageEnd,
	ev_messageStart,
	ev_textDelta,
	ev_textStart,
	makeFakeSession,
	FAKE_MODEL,
} = await import("./fake-session");
const { renderApp } = await import("./harness");

// Codex-shaped model stub. The reducer reads `modelProvider` from the
// store, which gets seeded from `agentSession.getModel().provider` at
// construction, so the fake must report `openai-codex` to trigger the
// transport detection branch.
const CODEX_MODEL: PiModel<PiApi> = {
	...FAKE_MODEL,
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-codex-responses",
	provider: "openai-codex",
	reasoning: true,
} as PiModel<PiApi>;

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	statsBySession.clear();
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

/**
 * Drive a full Codex turn through the reducer. `prompt()` takes the
 * pre-turn stats snapshot; `agent_end` reads the post-turn snapshot
 * and writes `"ws"` or `"sse"` to `store.codexTransport`.
 */
async function runTurn(fake: ReturnType<typeof makeFakeSession>) {
	await setup?.mockInput.typeText("hi");
	setup?.mockInput.pressEnter();
	await setup?.renderOnce();
	// Let the persistThen microtask settle so `actions.prompt` fires
	// and the pre-turn stats snapshot lands.
	await Bun.sleep(20);
	fake.emit(ev_agentStart());
	fake.emit(ev_messageStart());
	fake.emit(ev_textStart());
	fake.emit(ev_textDelta("ok"));
	fake.emit(ev_messageEnd({ content: [{ type: "text", text: "ok" }] }));
	fake.emit(ev_agentEnd([assistantMessage()]));
	await setup?.renderOnce();
	await Bun.sleep(10);
}

describe("codex transport detection", () => {
	test("SSE-path turn shows `sse` suffix on the statusline", async () => {
		const fake = makeFakeSession({ model: CODEX_MODEL });
		setup = await renderApp({
			session: fake.factory,
		});
		await setup.renderOnce();

		// Stats never populated for this sessionId → pre- and post-turn
		// diff is 0 → reducer writes `"sse"` to `store.codexTransport`.
		await runTurn(fake);

		const frame = setup.captureCharFrame();
		// The statusline renders `<model> <provider> · sse`. Look for the
		// suffix specifically (the provider display name is "ChatGPT", so
		// a bare `sse` search is unambiguous).
		expect(frame).toContain(" sse");
		expect(frame).not.toContain(" ws");
	});

	test("WebSocket-path turn shows `ws` suffix on the statusline", async () => {
		const fake = makeFakeSession({ model: CODEX_MODEL });
		setup = await renderApp({
			session: fake.factory,
		});
		await setup.renderOnce();

		// Simulate a WebSocket success by advancing the counter between
		// pre- and post-turn snapshots. Trigger the prompt, wait for
		// pre-snapshot, then advance stats before agent_end.
		await setup.mockInput.typeText("hi");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		// The TUI session id isn't directly exposed; read the first
		// `setSessionId` call on the fake.
		const sid = fake.calls.setSessionId[0];
		expect(sid).toBeDefined();
		if (!sid) return;

		// Advance the WebSocket counter so post-snapshot > pre-snapshot.
		statsBySession.set(sid, { connectionsCreated: 1, connectionsReused: 0 });

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("ok"));
		fake.emit(ev_messageEnd({ content: [{ type: "text", text: "ok" }] }));
		fake.emit(ev_agentEnd([assistantMessage()]));
		await setup.renderOnce();
		await Bun.sleep(20);

		const frame = setup.captureCharFrame();
		expect(frame).toContain(" ws");
		expect(frame).not.toContain(" sse");
	});

	test("second SSE-path turn overwrites the previous indicator (still `sse`)", async () => {
		const fake = makeFakeSession({ model: CODEX_MODEL });
		setup = await renderApp({
			session: fake.factory,
		});
		await setup.renderOnce();

		await runTurn(fake);
		expect(setup.captureCharFrame()).toContain(" sse");

		// Second turn with same no-WebSocket stats — indicator stays
		// `sse` (not promoted to `ws` by an incorrect post-only check).
		await runTurn(fake);
		expect(setup.captureCharFrame()).toContain(" sse");
		expect(setup.captureCharFrame()).not.toContain(" ws");
	});

	test("non-Codex turn (OpenRouter) never writes the indicator", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({
			session: fake.factory,
		});
		await setup.renderOnce();

		await runTurn(fake);

		const frame = setup.captureCharFrame();
		// Neither suffix appears for non-Codex providers. The statusline
		// still renders the model + provider name, but no transport tag.
		expect(frame).not.toContain(" · sse");
		expect(frame).not.toContain(" · ws");
	});
});
