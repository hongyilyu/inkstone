import { useCallback, useRef, useState } from "react";

/** The acknowledgement state of the most recent write: idle (nothing pending or
 * shown), saved (a write confirmed), or error (a write failed). */
export type SaveStatus = "idle" | "saved" | "error";

/**
 * An optimistically-updated, network-persisted setting with latest-write-wins
 * ordering and correct rollback.
 *
 * The naive `set(v); persist(v).then(setState).catch(revert)` shape has two
 * races this hook closes, both hit by rapid clicks on the same control:
 * - **out-of-order responses** — an older save resolving after a newer one would
 *   overwrite the newer choice. A monotonic token gates each resolution: only the
 *   newest write for this setting is allowed to commit or roll back.
 * - **wrong rollback target** — reverting to the value captured at click time can
 *   itself be an unsaved optimistic state, leaving the UI showing something never
 *   persisted. We roll back to the last CONFIRMED-persisted value instead.
 *
 * The network stays concurrent; only the *effect* is serialized to the user's
 * last action. `seed` syncs both the displayed value and the rollback snapshot
 * from a load (it does not count as a user write, so it never sets `status`).
 */
export function useOptimisticSetting<T>(
	initial: T,
	persist: (next: T) => Promise<T>,
) {
	const [value, setValue] = useState<T>(initial);
	const [status, setStatus] = useState<SaveStatus>("idle");
	// Monotonic write token (latest-write-wins) and the last confirmed-persisted
	// value (the only safe rollback target).
	const token = useRef(0);
	const persisted = useRef<T>(initial);

	/** Sync displayed value + rollback snapshot from a load. Not a user write. */
	const seed = useCallback((loaded: T) => {
		setValue(loaded);
		persisted.current = loaded;
	}, []);

	const set = useCallback(
		(next: T) => {
			const mine = ++token.current;
			setValue(next); // optimistic
			persist(next)
				.then((confirmed) => {
					if (mine !== token.current) return; // superseded by a newer write
					setValue(confirmed);
					persisted.current = confirmed; // advance the rollback snapshot
					setStatus("saved");
				})
				.catch(() => {
					if (mine !== token.current) return;
					setValue(persisted.current); // roll back to last confirmed-persisted
					setStatus("error");
				});
		},
		[persist],
	);

	/** Clear the transient acknowledgement (e.g. after a timeout). */
	const clearStatus = useCallback(() => setStatus("idle"), []);

	return { value, status, set, seed, clearStatus };
}
