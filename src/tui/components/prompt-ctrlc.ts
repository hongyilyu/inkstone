/**
 * Pure state machine for the prompt's Ctrl+C handler.
 *
 * Mirrors OpenCode's clear-on-text behavior (`prompt/index.tsx:1025-1042`)
 * with Inkstone's double-tap safety on the empty-prompt branch.
 *
 * Three transitions, named by their effect at the UI seam:
 *
 *   - `clear`  : non-empty buffer + Ctrl+C → wipe input, do NOT exit
 *   - `arm`    : empty buffer + Ctrl+C, not yet armed → show "again to exit"
 *   - `fall_through` : empty buffer + Ctrl+C, already armed → let the
 *                      layout-level `app_exit` handler perform the exit
 *
 * Pulling this out of the component lets us pin the table without
 * paying the OpenTUI test-renderer cost (which segfaults under Bun
 * 1.3.4 macOS in some teardown paths — see TODO.md Known Issues).
 *
 * Callers also handle: Ctrl+C inside a dialog → not our problem
 * (consumer must early-return before calling this), and the 5s
 * disarm timer (consumer owns the timer + `disarmExit` reset).
 */
export type CtrlCAction = "clear" | "arm" | "fall_through";

export interface CtrlCState {
	/** True when the prompt buffer has at least one character. */
	hasText: boolean;
	/** True after a prior Ctrl+C-on-empty has armed the exit hint. */
	armed: boolean;
}

export function deriveCtrlCAction(state: CtrlCState): CtrlCAction {
	if (state.hasText) return "clear";
	if (state.armed) return "fall_through";
	return "arm";
}
