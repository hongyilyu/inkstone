/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// vitest runs with cwd = apps/web; index.css lives at <cwd>/src/index.css.
const CSS = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

// Native date / datetime-local / checkbox controls follow the app theme and the
// single magenta ink only when the token wiring is present. jsdom can't compute
// `color-scheme` cascade or paint native controls, so we assert the wiring that
// produces the behavior — tolerant to whitespace, not exact spacing.

/**
 * Body of the rule whose selector list is exactly `selector` — the selector is
 * the last thing before `{` (only whitespace between), so this anchors to the
 * standalone `:root {…}` / `[data-theme="dark"] {…}` blocks and not to compound
 * selectors (`[data-theme="dark"] .prose {`) or the `@custom-variant` line that
 * merely mention the selector. Bodies have no nested braces.
 */
function ruleBody(selector: string): string {
	const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`(^|[};])\\s*${esc}\\s*\\{([^{}]*)\\}`);
	const m = CSS.match(re);
	if (!m) throw new Error(`no rule found for selector ${selector}`);
	return m[2];
}

describe("index.css theme token wiring", () => {
	it(":root opts into the light OS color-scheme", () => {
		expect(ruleBody(":root")).toMatch(/color-scheme\s*:\s*light/);
	});

	it('[data-theme="dark"] opts into the dark OS color-scheme', () => {
		expect(ruleBody('[data-theme="dark"]')).toMatch(/color-scheme\s*:\s*dark/);
	});

	it("form controls tint with the magenta --primary ink", () => {
		expect(CSS).toMatch(/accent-color\s*:\s*var\(\s*--primary\s*\)/);
	});
});
