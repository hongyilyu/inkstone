/**
 * Pure visibility state machine for the autocomplete popup.
 *
 * Extracted from `prompt-autocomplete.tsx` so the slash/mention
 * open/close rules can be reasoned about — and unit-tested — without
 * a TUI harness or reactive context.
 *
 * ## Contract
 *
 * Given the current textarea state (text, cursor, mode, trigger
 * index), decide what the popup should do next:
 *
 *   - `{ action: "open", mode, triggerIndex }` — open a new mode.
 *   - `{ action: "close" }` — close an active mode.
 *   - `{ action: "keep" }` — no transition; stay as-is.
 *
 * ## Rules (preserved from the pre-refactor inline logic)
 *
 * **Slash mode** (triggered by `/` at column 0):
 *   - Opens when the buffer starts with `/` and contains no
 *     whitespace.
 *   - Closes on whitespace appearing, buffer no longer starting with
 *     `/`, or empty buffer.
 *   - Slash takes precedence: while in slash mode, a typed `@` is
 *     part of the slash query and does NOT trigger mention mode.
 *
 * **Mention mode** (triggered by `@` after whitespace or at column 0):
 *   - Opens on the most recent `@` before the cursor with no
 *     whitespace between it and the cursor, where the preceding char
 *     is whitespace or undefined (start-of-buffer).
 *   - Closes when: buffer shorter than the trigger index, `@` no
 *     longer present at the trigger index, or the active query
 *     (trigger+1 up to cursor) contains whitespace.
 */

export type AutocompleteMode = "slash" | "mention";

export interface AutocompleteState {
	text: string;
	cursor: number;
	currentMode: AutocompleteMode | null;
	currentTriggerIndex: number;
}

export type AutocompleteTransition =
	| { action: "open"; mode: AutocompleteMode; triggerIndex: number }
	| { action: "close" }
	| { action: "keep" };

export function deriveNextMode(
	state: AutocompleteState,
): AutocompleteTransition {
	const { text, cursor, currentMode, currentTriggerIndex } = state;

	if (currentMode === null) {
		// Slash: `/` at column 0, no whitespace yet.
		if (text.startsWith("/") && !/\s/.test(text)) {
			return { action: "open", mode: "slash", triggerIndex: 0 };
		}
		// Mention: most recent `@` before the cursor with no whitespace
		// between it and the cursor, preceded by whitespace or BOF.
		const before = text.slice(0, cursor);
		const idx = before.lastIndexOf("@");
		if (idx === -1) return { action: "keep" };
		const between = before.slice(idx);
		if (/\s/.test(between)) return { action: "keep" };
		const preceding = idx === 0 ? undefined : before[idx - 1];
		if (preceding === undefined || /\s/.test(preceding)) {
			return { action: "open", mode: "mention", triggerIndex: idx };
		}
		return { action: "keep" };
	}

	if (currentMode === "slash") {
		if (!text.startsWith("/") || /\s/.test(text) || text.length === 0) {
			return { action: "close" };
		}
		return { action: "keep" };
	}

	// mention
	if (text.length <= currentTriggerIndex) return { action: "close" };
	if (text[currentTriggerIndex] !== "@") return { action: "close" };
	const activeQuery = text.slice(currentTriggerIndex + 1, cursor);
	if (/\s/.test(activeQuery)) return { action: "close" };
	// Safety net: user backed the cursor over whitespace at end of buffer.
	const query = text.slice(currentTriggerIndex + 1);
	if (/\s/.test(query) && cursor >= text.length) return { action: "close" };
	return { action: "keep" };
}
