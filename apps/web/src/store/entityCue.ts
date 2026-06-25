import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * Single-slot success-feedback cue for Library/GTD writes ("Created"/"Saved"/"Deleted");
 * a tiny vanilla store driven without prop threading (ADR-0020) so a mutation hook can
 * fire it outside React render. Latest-wins: one slot, no toast stack.
 */
export type CueVerb = "Created" | "Saved" | "Deleted";

export interface EntityCue {
	verb: CueVerb;
	/** Monotonic counter so the live region re-announces even on a repeat verb. */
	key: number;
}

interface CueState {
	cue: EntityCue | null;
}

/** How long a cue holds before it auto-dismisses. */
export const CUE_DISMISS_MS = 2500;

const store = createStore<CueState>()(() => ({ cue: null }));

let counter = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Show a cue: replace the slot, clear any pending dismiss, schedule a fresh one. */
export function showEntityCue(verb: CueVerb): void {
	if (timer !== undefined) {
		clearTimeout(timer);
	}
	store.setState({ cue: { verb, key: ++counter } });
	timer = setTimeout(() => {
		store.setState({ cue: null });
		timer = undefined;
	}, CUE_DISMISS_MS);
}

/** Clear the slot and the pending timer — for test isolation. */
export function resetEntityCueStore(): void {
	if (timer !== undefined) {
		clearTimeout(timer);
		timer = undefined;
	}
	store.setState({ cue: null });
}

/** Map an `entity/mutate` kind to its cue verb. A MAP, not `split("_")[0]`:
 * `mark_project_reviewed` and `reference_existing_entity_from_journal_entry` are
 * real kinds that must read as "Saved". Rules apply in order. */
export function verbForMutationKind(kind: string): CueVerb {
	if (kind.startsWith("delete_")) {
		return "Deleted";
	}
	if (kind.startsWith("create_")) {
		return "Created";
	}
	return "Saved";
}

/** Non-hook read for tests + non-render callers. */
export function currentCue(): EntityCue | null {
	return store.getState().cue;
}

export function useEntityCue(): EntityCue | null {
	return useStore(store, (s) => s.cue);
}
