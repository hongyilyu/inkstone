/**
 * Unit tests for the prompt's Ctrl+C state machine.
 *
 * The full integration path (mount, send Ctrl+C, observe frame) is
 * skipped because feeding `\x03` through OpenTUI's MockInput while
 * a Solid component owns a pending `setTimeout` and a `useKeyboard`
 * subscription triggers the Bun 1.3.4 macOS segfault documented in
 * `docs/TODO.md` Known Issues (the "Promise-holding owner is disposed"
 * teardown path). Pinning the pure transition table here matches the
 * approach `mode-state.ts` takes for the autocomplete state machine.
 *
 * The 5s disarm timer + dialog-scope guard live in the consumer
 * (prompt.tsx); see the manual verification steps in the plan file
 * for end-to-end coverage.
 */

import { describe, expect, test } from "bun:test";
import { deriveCtrlCAction } from "../../src/tui/components/prompt-ctrlc";

describe("deriveCtrlCAction", () => {
	test("non-empty buffer always clears, regardless of armed state", () => {
		expect(deriveCtrlCAction({ hasText: true, armed: false })).toBe("clear");
		expect(deriveCtrlCAction({ hasText: true, armed: true })).toBe("clear");
	});

	test("empty buffer + not armed arms the exit hint", () => {
		expect(deriveCtrlCAction({ hasText: false, armed: false })).toBe("arm");
	});

	test("empty buffer + armed falls through to layout exit handler", () => {
		expect(deriveCtrlCAction({ hasText: false, armed: true })).toBe(
			"fall_through",
		);
	});
});
