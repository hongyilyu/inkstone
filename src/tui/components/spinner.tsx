import type { RGBA } from "@opentui/core";
import { createSignal, onCleanup, onMount } from "solid-js";
import { useTheme } from "../context/theme";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Simple braille-dot spinner. Port of OpenCode's generic `Spinner` component
 * (../opencode/packages/opencode/src/cli/cmd/tui/component/spinner.tsx), minus
 * the animations-disabled KV fallback (Inkstone has no equivalent toggle).
 *
 * Kept as a standalone importable component for reuse in future status
 * indicators (e.g. subagent activity, background tool runs) — not currently
 * used by the main prompt, which uses `SpinnerWave` instead.
 */
export function Spinner(props: { color?: RGBA }) {
	const { theme } = useTheme();
	const [frame, setFrame] = createSignal(0);

	onMount(() => {
		const interval = setInterval(() => {
			setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
		}, 80);
		onCleanup(() => clearInterval(interval));
	});

	return (
		<text fg={props.color ?? theme.textMuted}>{SPINNER_FRAMES[frame()]}</text>
	);
}
