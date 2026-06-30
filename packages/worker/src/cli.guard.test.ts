/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Production-entry guard: cli.ts must carry no faux/test-only provider code (ADR-0019) — see docs/design/worker-tests.md
const BANNED = [
	"INKSTONE_FAUX",
	"fauxProvider",
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
		// Also catch a faux entry import (now under ./faux/), which would pull faux scripting into production without tripping a token above.
		expect(text).not.toMatch(
			/^\s*import\s+.*from\s+["']\.\/faux\/faux-worker(?:\.js)?["'];?/m,
		);
	});
});
