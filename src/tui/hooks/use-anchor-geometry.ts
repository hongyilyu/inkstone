/**
 * Track a flex-laid-out anchor's screen position + size, reactively.
 *
 * OpenTUI's layout coordinates (`x`, `y`, `width`) aren't reactive
 * on the renderable — they're plain getters updated by Yoga after
 * each layout pass. To keep floating UI (e.g. the autocomplete
 * popup) glued to a laid-out anchor, this hook polls `anchor.x/y/
 * width` every 50ms while visible and bumps an internal tick
 * signal when any change.
 *
 * The returned accessor yields **anchor-relative** coordinates
 * (subtracting the anchor's parent `x/y`) so the popup's
 * `position="absolute"` resolves against the parent's coordinate
 * space — same as OpenCode's pattern at
 * `component/prompt/autocomplete.tsx:97-126, 603-608`.
 *
 * `useTerminalDimensions()` is read inside the geometry memo so a
 * terminal resize forces re-evaluation on the next frame without
 * waiting for the 50ms poll.
 *
 * Height is clamped against headroom above the anchor (`anchor.y`)
 * so the popup never tries to render at negative `top` on short
 * terminals.
 *
 * The `+1 / -1` horizontal offsets align the popup's opaque
 * background with the prompt bubble's inner content area, leaving
 * the agent-tinted `┃` left-border column visible as an
 * uninterrupted vertical stroke. These numbers are tied to the
 * specific prompt bubble layout in `prompt.tsx` — if the bubble's
 * chrome changes width, adjust here.
 */

import type { BoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
} from "solid-js";

export interface AnchorGeometry {
	/** Anchor-relative `top` for absolute positioning (row offset). */
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface AnchorGeometryOptions {
	/** Live anchor ref. Returns `undefined` until the renderable mounts. */
	anchor: () => BoxRenderable | undefined;
	/** Gate: the 50ms poll only runs while this is true. */
	visible: () => boolean;
	/** Height driver: number of list rows the popup wants to render. */
	itemCount: () => number;
	/** Hard cap on height (e.g. `MAX_RESULTS`). */
	maxItems: number;
}

export function useAnchorGeometry(
	opts: AnchorGeometryOptions,
): Accessor<AnchorGeometry> {
	const [positionTick, setPositionTick] = createSignal(0);
	const dimensions = useTerminalDimensions();

	createEffect(() => {
		if (!opts.visible()) return;
		let last = { x: 0, y: 0, width: 0 };
		const interval = setInterval(() => {
			const a = opts.anchor();
			if (!a) return;
			if (a.x !== last.x || a.y !== last.y || a.width !== last.width) {
				last = { x: a.x, y: a.y, width: a.width };
				setPositionTick((t) => t + 1);
			}
		}, 50);
		onCleanup(() => clearInterval(interval));
	});

	return createMemo<AnchorGeometry>(() => {
		dimensions();
		positionTick();
		const a = opts.anchor();
		if (!a) return { x: 0, y: 0, width: 0, height: 0 };
		const headroom = Math.max(1, a.y);
		const height = Math.min(opts.maxItems, opts.itemCount(), headroom);
		return {
			x: a.x - (a.parent?.x ?? 0) + 1,
			y: a.y - (a.parent?.y ?? 0) - height,
			width: Math.max(0, a.width - 1),
			height,
		};
	});
}
