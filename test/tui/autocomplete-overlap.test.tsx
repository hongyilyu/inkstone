/**
 * Regression tests for the autocomplete dropdown bleed-through bug.
 *
 * The reported bug: typing `/` over a conversation showed dropdown
 * entries interleaved with the last assistant line's chars — e.g.
 * `/azebra-marker-texte for guided reading` instead of `/article`
 * on its own opaque row. Root cause had two parts:
 *
 *   1. OpenTUI's zIndex only orders siblings within one parent. The
 *      dropdown's `zIndex={100}` inside the prompt wrapper didn't
 *      beat the Conversation sibling two parents up in the layout —
 *      the Conversation rendered ON TOP of the dropdown at shared
 *      screen cells. Fix: `zIndex={10}` on the prompt wrapper in
 *      `app.tsx`, bringing the wrapper (and its descendant dropdown)
 *      above the Conversation at the Layout level.
 *
 *   2. `border=["top","bottom"]` on the absolute box painted border
 *      chars at border offsets but left inter-glyph cells transparent,
 *      so even with correct z-order the border rows leaked. Fix: port
 *      OpenCode's `SplitBorder` (left/right `┃` only) + explicit
 *      `backgroundColor={theme.backgroundElement}` on the outer and
 *      inner boxes.
 *
 *   3. Fixed `bottom={6}` positioning drifted into the bubble as the
 *      bubble grew. Fix: anchor the dropdown to a measured `anchor.y`
 *      via a 50ms poll, mirroring OpenCode's pattern.
 *
 * These tests pin the observable behaviors from char-frame.
 */

import { afterEach, describe, expect, test } from "bun:test";
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

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

describe("autocomplete dropdown", () => {
	test("dropdown entries render cleanly over a conversation (no bleed-through)", async () => {
		// Seed a full turn with a distinctive marker in the assistant
		// reply, then open the dropdown above. Pre-fix, the marker's
		// chars interleaved with the entry text. Post-fix, entries
		// render as contiguous substrings exactly as the registry
		// defined them.
		const fake = makeFakeSession();
		// Match the user's reported geometry: wide terminal, short
		// height, so the dropdown sits directly over a completed
		// assistant line.
		setup = await renderApp({ session: fake.factory, width: 180, height: 15 });
		await setup.renderOnce();

		await setup.mockInput.typeText("asdilgkf adsga");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(
			ev_textDelta(
				"Still noise on my end. I'll hold here — whenever you're ready with a recap or a question, send it through.",
			),
		);
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));
		await waitForFrame(setup, "send it through");

		await setup.mockInput.typeText("/");
		await waitForFrame(setup, "/clear");

		// All three entries appear as contiguous, uncorrupted substrings.
		// With the pre-fix bleed-through, `/article     Open an article`
		// became `/azebra-overlap-marker-texte Open an article` (mixed
		// with the assistant footer `▣ Reader · Anthropic:…`).
		const frame = setup.captureCharFrame();
		expect(frame).toContain("/article     Open an article for guided reading");
		expect(frame).toContain("/clear       Clear the current session");
		expect(frame).toContain(
			"/mini-model  Small model for background title generation",
		);
	});

	test("dropdown entries sit directly above the prompt bubble", async () => {
		// With no top/bottom border rows, the dropdown's last entry
		// row sits on `bubbleTopRow - 1` — flush against the bubble.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("/");
		await waitForFrame(setup, "/clear");

		const rows = setup.captureCharFrame().split("\n");

		// Dropdown entry rows start with `    /…` (indented by the
		// popup's `left=position().x+1` offset + entry `paddingLeft=2`,
		// no left border glyph on the popup itself). Match the entry
		// name on any line; the rows that contain it are the dropdown.
		const entryRowIndices: number[] = [];
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i] ?? "";
			if (
				row.includes("/article") &&
				row.includes("Open an article for guided reading")
			) {
				entryRowIndices.push(i);
			} else if (
				row.includes("/mini-model") &&
				row.includes("Small model for background title generation")
			) {
				entryRowIndices.push(i);
			} else if (
				row.includes("/clear") &&
				row.includes("Clear the current session")
			) {
				entryRowIndices.push(i);
			}
		}
		expect(entryRowIndices.length).toBeGreaterThan(0);
		const lastEntryRow = entryRowIndices[entryRowIndices.length - 1] as number;

		// Bubble top: the first `┃` row strictly after the last entry
		// row. With the fix, this is exactly `lastEntryRow + 1`.
		let bubbleTopRow = -1;
		for (let i = lastEntryRow + 1; i < rows.length; i++) {
			if (rows[i]?.includes("┃")) {
				bubbleTopRow = i;
				break;
			}
		}
		expect(bubbleTopRow).toBe(lastEntryRow + 1);
	});

	test("dropdown stays inside the terminal on short viewports", async () => {
		// Short terminal: the dropdown's `listHeight` clamp by
		// `Math.max(1, anchor.y)` keeps it inside the frame.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, height: 12 });
		await setup.renderOnce();

		await setup.mockInput.typeText("/");
		await waitForFrame(setup, "/clear");

		const frame = setup.captureCharFrame();
		expect(frame).toContain("/clear");
		const rows = frame.split("\n");
		const firstEntryRow = rows.findIndex(
			(r) =>
				(r.includes("/article") && r.includes("Open an article")) ||
				(r.includes("/mini-model") && r.includes("Small model")) ||
				(r.includes("/clear") && r.includes("Clear the current")),
		);
		expect(firstEntryRow).toBeGreaterThanOrEqual(0);
	});

	test("dropdown entry slashes align with the textarea slash", async () => {
		// Visual alignment invariant: when the user types `/` at
		// column 0 of the textarea, the dropdown entry `/` chars sit
		// at the same screen column as the textarea `/`. The popup
		// starts 1 column right of the bubble's left border + 2
		// columns of inner padding == bubble's inner paddingLeft, so
		// both `/` marks line up vertically.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("/a");
		await waitForFrame(setup, "/article");

		const rows = setup.captureCharFrame().split("\n");
		const textareaRow = rows.find((r) => /^\s*┃\s+\/a/.test(r));
		const entryRow = rows.find(
			(r) => r.includes("/article") && r.includes("Open an article for guided"),
		);
		expect(textareaRow).toBeTruthy();
		expect(entryRow).toBeTruthy();

		// Find the column of the first `/` on each row.
		const textareaSlashCol = (textareaRow as string).indexOf("/");
		const entrySlashCol = (entryRow as string).indexOf("/");
		expect(textareaSlashCol).toBeGreaterThan(0);
		expect(entrySlashCol).toBe(textareaSlashCol);
	});

	test("popup background starts right of the bubble's `┃` border column", async () => {
		// Visual alignment invariant: the popup's opaque background
		// begins exactly one column right of the bubble's `┃` left
		// border, so the agent-tinted `┃` remains visible as a
		// continuous vertical stroke. Asserted via bg-color spans on
		// a dropdown entry row: the bg at the bubble-border column
		// matches the ambient (outer) background, and the bg at
		// `bubbleBorderCol + 1` differs (it's the popup's menu bg
		// or the selected-entry primary color).
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("/a");
		await waitForFrame(setup, "/article");
		await waitForFrame(setup, "Open an article for guided");

		const rows = setup.captureCharFrame().split("\n");
		const entryRowIdx = rows.findIndex((r) => r?.includes("/article     "));
		expect(entryRowIdx).toBeGreaterThan(0);

		// Bubble's `┃` column from a `┃` row after the dropdown.
		let bubbleBorderCol = -1;
		for (let i = entryRowIdx + 1; i < rows.length; i++) {
			const col = (rows[i] ?? "").indexOf("┃");
			if (col >= 0) {
				bubbleBorderCol = col;
				break;
			}
		}
		expect(bubbleBorderCol).toBeGreaterThan(0);

		// Walk entry-row spans and tag each column with its bg
		// color. The bg at `bubbleBorderCol` must match the
		// ambient/outer background, and the bg at
		// `bubbleBorderCol + 1` must differ (it's the popup).
		const spans = setup.captureSpans();
		const row = spans.lines[entryRowIdx] as {
			spans: Array<{
				text: string;
				width: number;
				bg?: { buffer: Record<string, number> };
			}>;
		};
		const bgAt = (targetCol: number): string => {
			let col = 0;
			for (const span of row.spans) {
				if (targetCol >= col && targetCol < col + span.width) {
					const bg = span.bg?.buffer ?? {};
					const r = Math.round((bg[0] ?? 0) * 255);
					const g = Math.round((bg[1] ?? 0) * 255);
					const b = Math.round((bg[2] ?? 0) * 255);
					return `${r},${g},${b}`;
				}
				col += span.width;
			}
			return "unknown";
		};

		const bgAtBorder = bgAt(bubbleBorderCol);
		const bgRightOfBorder = bgAt(bubbleBorderCol + 1);
		expect(bgAtBorder).not.toBe(bgRightOfBorder);
	});
});
