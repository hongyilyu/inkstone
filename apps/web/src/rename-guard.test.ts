import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// PR1 (slice 9) purged the chat-role identifiers from apps/web/src. This guard
// reads every source file and asserts none reintroduce them, so the rename
// stays complete as later slices stack on it.
//
// Scoped to the chat-role *identifiers* — NOT a blunt "agent" substring — so:
//   - the automations domain ("agent run" comments + Automation/AutomationRun
//     types in data/mock/types.ts) is intentionally NOT flagged, and
//   - the user-facing "Turn standup action items…" prompt copy in
//     data/mock/history.ts is intentionally NOT flagged.
// The guard file itself is excluded from the scan (it names the banned tokens).
const BANNED = [
	"ChatTurn",
	"AgentBubble",
	"AgentActions",
	"AgentProposals",
	'role: "agent"',
	'role:"agent"',
	'data-role="agent"',
];

// vitest runs with cwd = apps/web, so the source tree is <cwd>/src and this
// guard file is the one we exclude from the scan.
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
