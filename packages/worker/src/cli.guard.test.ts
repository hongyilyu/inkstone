/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Production-entry guard (ADR-0019 as-built: faux scripting lives in the
// test-only `faux-worker.ts`, never the shipping path). `cli.ts` is the
// production Worker entry Core spawns in a real build; it must carry NO
// test-only faux-provider code. This guard reads cli.ts and asserts none of the
// faux tokens reappear, so the eviction stays complete as later work stacks on
// it. (`faux-worker.ts` is the legitimate home for these — not scanned here.)
const BANNED = [
	"INKSTONE_FAUX",
	"registerFauxProvider",
	"fauxAssistantMessage",
	"fauxToolCall",
	"fauxDepsFor",
];

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

describe("production entry guard", () => {
	it("cli.ts carries no faux/test-only provider code", () => {
		const text = readFileSync(CLI, "utf8");
		const offenders = BANNED.filter((token) => text.includes(token));
		expect(offenders).toEqual([]);
		// Also catch direct wiring to the test-only entry: an import of
		// `./faux-worker` would pull faux scripting into production without
		// tripping any token above.
		expect(text).not.toMatch(
			/^\s*import\s+.*from\s+["']\.\/faux-worker(?:\.js)?["'];?/m,
		);
	});
});
