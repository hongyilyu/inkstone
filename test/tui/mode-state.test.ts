/**
 * Unit tests for `deriveNextMode` — the pure visibility state machine
 * that drives the autocomplete popup's open/close decisions.
 *
 * Pins the 11 transitions listed in the JSDoc of
 * `src/tui/components/prompt-autocomplete-mode.ts`. These are the
 * rules the pre-refactor inline effect enforced; preserving them
 * across the extraction is the contract.
 */

import { describe, expect, test } from "bun:test";
import { deriveNextMode } from "../../src/tui/components/prompt-autocomplete-mode";

describe("deriveNextMode — null current mode", () => {
	test("opens slash mode on `/` at column 0", () => {
		expect(
			deriveNextMode({
				text: "/",
				cursor: 1,
				currentMode: null,
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "open", mode: "slash", triggerIndex: 0 });
	});

	test("opens slash mode on `/a` (no whitespace yet)", () => {
		expect(
			deriveNextMode({
				text: "/a",
				cursor: 2,
				currentMode: null,
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "open", mode: "slash", triggerIndex: 0 });
	});

	test("does NOT open slash mode on `/ ` (space)", () => {
		expect(
			deriveNextMode({
				text: "/ ",
				cursor: 2,
				currentMode: null,
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "keep" });
	});

	test("opens mention mode on `@` at column 0", () => {
		expect(
			deriveNextMode({
				text: "@",
				cursor: 1,
				currentMode: null,
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "open", mode: "mention", triggerIndex: 0 });
	});

	test("opens mention mode on `@foo` after whitespace", () => {
		expect(
			deriveNextMode({
				text: "hello @foo",
				cursor: 10,
				currentMode: null,
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "open", mode: "mention", triggerIndex: 6 });
	});

	test("does NOT open mention mode on `foo@bar` (@ not after whitespace)", () => {
		expect(
			deriveNextMode({
				text: "foo@bar",
				cursor: 7,
				currentMode: null,
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "keep" });
	});

	test("does NOT open mention mode when query contains whitespace", () => {
		// `@foo bar`: `@` present but `bar` is past a space.
		// `lastIndexOf('@')` is 0; `between = '@foo bar'` contains a
		// space, so rejected.
		expect(
			deriveNextMode({
				text: "@foo bar",
				cursor: 8,
				currentMode: null,
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "keep" });
	});

	test("does NOT open anything on empty buffer", () => {
		expect(
			deriveNextMode({
				text: "",
				cursor: 0,
				currentMode: null,
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "keep" });
	});
});

describe("deriveNextMode — slash mode active", () => {
	test("keeps slash mode on continued no-whitespace typing", () => {
		expect(
			deriveNextMode({
				text: "/article",
				cursor: 8,
				currentMode: "slash",
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "keep" });
	});

	test("closes slash mode when whitespace appears", () => {
		expect(
			deriveNextMode({
				text: "/article ",
				cursor: 9,
				currentMode: "slash",
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "close" });
	});

	test("closes slash mode when buffer no longer starts with `/`", () => {
		expect(
			deriveNextMode({
				text: "article",
				cursor: 7,
				currentMode: "slash",
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "close" });
	});

	test("closes slash mode on empty buffer", () => {
		expect(
			deriveNextMode({
				text: "",
				cursor: 0,
				currentMode: "slash",
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "close" });
	});

	test("slash-precedence: `@` typed while in slash mode does NOT open mention", () => {
		// In slash mode, `@` is part of the slash query. The derivation
		// returns `keep` (stay in slash), not a transition to mention.
		expect(
			deriveNextMode({
				text: "/article@",
				cursor: 9,
				currentMode: "slash",
				currentTriggerIndex: 0,
			}),
		).toEqual({ action: "keep" });
	});
});

describe("deriveNextMode — mention mode active", () => {
	test("keeps mention mode on continued no-whitespace typing after @", () => {
		expect(
			deriveNextMode({
				text: "hello @foo",
				cursor: 10,
				currentMode: "mention",
				currentTriggerIndex: 6,
			}),
		).toEqual({ action: "keep" });
	});

	test("closes mention mode when buffer shorter than trigger index", () => {
		// User backspaced past the `@`.
		expect(
			deriveNextMode({
				text: "hel",
				cursor: 3,
				currentMode: "mention",
				currentTriggerIndex: 6,
			}),
		).toEqual({ action: "close" });
	});

	test("closes mention mode when `@` no longer at trigger index", () => {
		expect(
			deriveNextMode({
				text: "hello xfoo",
				cursor: 10,
				currentMode: "mention",
				currentTriggerIndex: 6,
			}),
		).toEqual({ action: "close" });
	});

	test("closes mention mode when whitespace appears in active query", () => {
		expect(
			deriveNextMode({
				text: "hello @foo bar",
				cursor: 14,
				currentMode: "mention",
				currentTriggerIndex: 6,
			}),
		).toEqual({ action: "close" });
	});
});
