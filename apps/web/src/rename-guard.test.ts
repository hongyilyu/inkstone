/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Banned chat-role *identifiers* (not a blunt "agent" substring) — see docs/design/web-component-tests.md.
const BANNED = [
	"ChatTurn",
	"AgentBubble",
	"AgentActions",
	"AgentProposals",
	'role: "agent"',
	'role:"agent"',
	'data-role="agent"',
];

// vitest runs with cwd = apps/web, so the source tree is <cwd>/src.
const SRC_DIR = join(process.cwd(), "src");
const SELF = join(SRC_DIR, "rename-guard.test.ts");

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...sourceFiles(full));
		} else if (/\.(ts|tsx)$/.test(entry.name) && full !== SELF) {
			out.push(full);
		}
	}
	return out;
}

describe("rename guard", () => {
	it("no banned chat-role identifiers remain in apps/web/src", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(SRC_DIR)) {
			const text = readFileSync(file, "utf8");
			for (const token of BANNED) {
				if (text.includes(token)) offenders.push(`${file}: ${token}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
