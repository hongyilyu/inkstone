import { RGBA } from "@opentui/core";
import { createMemo, createSignal, Index, onCleanup, onMount } from "solid-js";

/**
 * 8-cell bidirectional Knight Rider wave spinner.
 *
 * Port of OpenCode's prompt-line spinner — the animation logic comes from
 * `../opencode/packages/opencode/src/cli/cmd/tui/ui/spinner.ts` (createFrames /
 * createKnightRiderTrail, blocks + bidirectional branches only), wired up the
 * way OpenCode's `component/prompt/index.tsx:927-946, 1262-1265` configures
 * the `<spinner>` renderable.
 *
 * Trimmed compared to the upstream source:
 *   - only "blocks" glyph style (drop diamonds)
 *   - only bidirectional sweep (drop forward-only / backward-only)
 *   - constants baked in instead of per-call options
 *   - no per-frame RGBA caching / mutation (fresh RGBA each cell so Solid
 *     picks up the change; one spinner in the UI makes caching irrelevant)
 *
 * Since `opentui-spinner` isn't installed, we drive the tick ourselves with
 * the same `onMount → setInterval → onCleanup` pattern the rest of the TUI
 * uses, and render per-character color by emitting one `<span>` per cell
 * inside a `<text>` parent (the pattern already used at
 * `src/tui/components/prompt.tsx` for the `esc interrupt` hint).
 */

// Matches OpenCode's prompt-line configuration
// (prompt/index.tsx:927-946 → `style: "blocks"`, `inactiveFactor: 0.6`,
// `minAlpha: 0.3`, plus spinner.ts defaults for width / holdStart / holdEnd /
// trailSteps; prompt/index.tsx:1263 → `interval={40}`).
const WIDTH = 8;
const HOLD_START = 30;
const HOLD_END = 9;
const TRAIL_STEPS = 6;
const INACTIVE_FACTOR = 0.6;
const MIN_ALPHA = 0.3;
const FRAME_INTERVAL_MS = 40;

// Active cell glyph (U+25A0 ■) and inactive placeholder (U+2B1D ⬝).
// Both BMP, single UTF-16 code unit — safe to index after `Array.from`.
const GLYPH_ACTIVE = "■";
const GLYPH_INACTIVE = "⬝";

interface ScannerState {
	activePosition: number;
	isHolding: boolean;
	holdProgress: number;
	holdTotal: number;
	movementProgress: number;
	movementTotal: number;
	isMovingForward: boolean;
}

/**
 * Bidirectional cycle, one branch per phase:
 *   forward (WIDTH frames) → hold end (HOLD_END) → backward (WIDTH-1) → hold start (HOLD_START).
 * Ported from spinner.ts:25-103, bidirectional branch only.
 */
function getScannerState(frameIndex: number, totalChars: number): ScannerState {
	const forwardFrames = totalChars;
	const backwardFrames = totalChars - 1;

	if (frameIndex < forwardFrames) {
		return {
			activePosition: frameIndex,
			isHolding: false,
			holdProgress: 0,
			holdTotal: 0,
			movementProgress: frameIndex,
			movementTotal: forwardFrames,
			isMovingForward: true,
		};
	}
	if (frameIndex < forwardFrames + HOLD_END) {
		return {
			activePosition: totalChars - 1,
			isHolding: true,
			holdProgress: frameIndex - forwardFrames,
			holdTotal: HOLD_END,
			movementProgress: 0,
			movementTotal: 0,
			isMovingForward: true,
		};
	}
	if (frameIndex < forwardFrames + HOLD_END + backwardFrames) {
		const backwardIndex = frameIndex - forwardFrames - HOLD_END;
		return {
			activePosition: totalChars - 2 - backwardIndex,
			isHolding: false,
			holdProgress: 0,
			holdTotal: 0,
			movementProgress: backwardIndex,
			movementTotal: backwardFrames,
			isMovingForward: false,
		};
	}
	return {
		activePosition: 0,
		isHolding: true,
		holdProgress: frameIndex - forwardFrames - HOLD_END - backwardFrames,
		holdTotal: HOLD_START,
		movementProgress: 0,
		movementTotal: 0,
		isMovingForward: false,
	};
}

/**
 * For a given cell, return its trail-palette index (0 = bright head, 1..N-1 =
 * fading trail) or -1 for an inactive cell. During hold phases the index is
 * shifted by `holdProgress` so the head "fades into the trail" at the edge.
 *
 * Ported from spinner.ts:106-139.
 */
function calculateColorIndex(
	charIndex: number,
	trailLength: number,
	state: ScannerState,
): number {
	const directionalDistance = state.isMovingForward
		? state.activePosition - charIndex
		: charIndex - state.activePosition;

	if (state.isHolding) return directionalDistance + state.holdProgress;
	if (directionalDistance > 0 && directionalDistance < trailLength)
		return directionalDistance;
	if (directionalDistance === 0) return 0;
	return -1;
}

/**
 * 6-step trail palette derived from a single base color:
 *   i=0: full brightness, α=1.0 (head)
 *   i=1: +15% bloom, α=0.9
 *   i≥2: α = 0.65^(i-1) (exponential decay)
 * Ported from spinner.ts:199-231.
 */
function deriveTrailColors(base: RGBA): RGBA[] {
	const out: RGBA[] = [];
	for (let i = 0; i < TRAIL_STEPS; i++) {
		let alpha: number;
		let brightness: number;
		if (i === 0) {
			alpha = 1.0;
			brightness = 1.0;
		} else if (i === 1) {
			alpha = 0.9;
			brightness = 1.15;
		} else {
			alpha = 0.65 ** (i - 1);
			brightness = 1.0;
		}
		out.push(
			RGBA.fromValues(
				Math.min(1, base.r * brightness),
				Math.min(1, base.g * brightness),
				Math.min(1, base.b * brightness),
				alpha,
			),
		);
	}
	return out;
}

/**
 * Precomputed frame strings (static — only the colors change each tick).
 * Ported from createFrames's blocks branch at spinner.ts:272-329.
 */
const FRAMES: string[] = (() => {
	const total = WIDTH + HOLD_END + (WIDTH - 1) + HOLD_START;
	return Array.from({ length: total }, (_, frameIndex) => {
		const state = getScannerState(frameIndex, WIDTH);
		return Array.from({ length: WIDTH }, (_, charIndex) => {
			const idx = calculateColorIndex(charIndex, TRAIL_STEPS, state);
			return idx >= 0 && idx < TRAIL_STEPS ? GLYPH_ACTIVE : GLYPH_INACTIVE;
		}).join("");
	});
})();

const TOTAL_FRAMES = FRAMES.length;

/**
 * Build a per-(frame, charIndex) color function for a given base color.
 * Ported from createKnightRiderTrail at spinner.ts:141-191. Always-on fading,
 * `MIN_ALPHA` floor, fresh RGBA returned per call (no shared mutation).
 */
function makeColorer(base: RGBA) {
	const trail = deriveTrailColors(base);
	return (frameIndex: number, charIndex: number): RGBA => {
		const state = getScannerState(frameIndex, WIDTH);
		const idx = calculateColorIndex(charIndex, TRAIL_STEPS, state);

		// Fade: linear in during movement, linear out while holding, clamped
		// to MIN_ALPHA at the far end. spinner.ts:168-178.
		let fadeFactor = 1;
		if (state.isHolding && state.holdTotal > 0) {
			const p = Math.min(state.holdProgress / state.holdTotal, 1);
			fadeFactor = Math.max(MIN_ALPHA, 1 - p * (1 - MIN_ALPHA));
		} else if (!state.isHolding && state.movementTotal > 0) {
			const p = Math.min(
				state.movementProgress / Math.max(1, state.movementTotal - 1),
				1,
			);
			fadeFactor = MIN_ALPHA + p * (1 - MIN_ALPHA);
		}

		const inTrail = idx >= 0 && idx < TRAIL_STEPS;
		const palette = inTrail ? trail[idx] : undefined;
		if (palette) return palette;

		// Inactive cell (or hold-shifted past the trail): base RGB at reduced α.
		return RGBA.fromValues(
			base.r,
			base.g,
			base.b,
			INACTIVE_FACTOR * fadeFactor,
		);
	};
}

export function SpinnerWave(props: { color: RGBA }) {
	const colorer = createMemo(() => makeColorer(props.color));
	const [frameIdx, setFrameIdx] = createSignal(0);
	const chars = createMemo(() =>
		// biome-ignore lint/style/noNonNullAssertion: FRAMES is non-empty and frameIdx is modulo-clamped
		Array.from(FRAMES[frameIdx() % TOTAL_FRAMES]!),
	);

	onMount(() => {
		const id = setInterval(() => {
			setFrameIdx((f) => (f + 1) % TOTAL_FRAMES);
		}, FRAME_INTERVAL_MS);
		onCleanup(() => clearInterval(id));
	});

	return (
		<box flexDirection="row">
			<Index each={chars()}>
				{(ch, i) => <text fg={colorer()(frameIdx(), i)}>{ch()}</text>}
			</Index>
		</box>
	);
}
