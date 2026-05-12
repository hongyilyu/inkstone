import { onCleanup } from "solid-js";

/**
 * Schedule `setInterval` for the lifetime of the current Solid owner.
 *
 * Fires synchronously during setup, registers `onCleanup` against the
 * current owner so the interval clears on component unmount or effect
 * re-run. Compose freely inside `createEffect` — each re-run gets its
 * own interval + cleanup pair via the per-run owner.
 */
export function createInterval(callback: () => void, ms: number): void {
	const id = setInterval(callback, ms);
	onCleanup(() => clearInterval(id));
}
