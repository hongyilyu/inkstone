/**
 * Integration test: span instrumentation propagates through real TUI
 * code paths. Exercises promptAction's `agent.turn` span and confirms
 * that downstream log lines emitted inside the await-chain inherit
 * the span's structured fields (sessionId, agent, provider, modelId).
 *
 * Why integration vs unit: the public goal is "logs from inside a
 * turn carry session context." A unit test of the helper passed in
 * cycle 9; this asserts the wiring works through the real prompt
 * action and reducer plumbing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { logger, type Sink, setSink } from "@backend/logger";
import {
	assistantMessage,
	ev_agentEnd,
	ev_agentStart,
	ev_messageEnd,
	ev_messageStart,
	ev_textDelta,
	ev_textStart,
	makeFakeSession,
} from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

interface MemorySink extends Sink {
	lines: string[];
}

function memorySink(): MemorySink {
	const lines: string[] = [];
	return {
		write: (line) => lines.push(line),
		lines,
	};
}

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;
let mem: MemorySink;

beforeEach(() => {
	mem = memorySink();
	setSink(mem);
	logger.setLevel("debug");
});

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
	setSink(null);
});

describe("logger spans — integration through promptAction", () => {
	test("agent.turn span emits enter/exit around a turn", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("hi there");
		setup.mockInput.pressEnter();
		await setup.renderOnce();

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("Hello"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));
		await waitForFrame(setup, "Hello");

		const enter = mem.lines.find(
			(l) => l.includes("[agent.turn]") && l.includes("enter"),
		);
		const exit = mem.lines.find(
			(l) => l.includes("[agent.turn]") && l.includes("exit ok"),
		);
		expect(enter).toBeDefined();
		expect(exit).toBeDefined();
		expect(enter).toContain("sessionId=");
		expect(enter).toContain("agent=");
		expect(exit).toMatch(/dur=\d+ms/);
	});
});
