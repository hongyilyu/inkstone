import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** Local, non-durable UI state for the Library (VISUAL ONLY; resets on reload). */
interface LibraryState {
	/** Per-todo done overrides on top of the mock's static `done`. */
	doneOverrides: Record<string, boolean>;
	/** Library item ids the user has confirmed out of the "Needs review" digest. */
	confirmed: Record<string, true>;
}

const store = createStore<LibraryState>()(() => ({
	doneOverrides: {},
	confirmed: {},
}));

export function setTodoDone(id: string, done: boolean): void {
	store.setState((s) => ({
		...s,
		doneOverrides: { ...s.doneOverrides, [id]: done },
	}));
}

export function confirmReview(id: string): void {
	store.setState((s) => ({ ...s, confirmed: { ...s.confirmed, [id]: true } }));
}

/** Reset to empty — for test isolation. */
export function resetLibraryStore(): void {
	store.setState({ doneOverrides: {}, confirmed: {} });
}

export function useTodoDone(id: string, fallback: boolean): boolean {
	return useStore(store, (s) => s.doneOverrides[id] ?? fallback);
}

export function useConfirmedReviews(): Record<string, true> {
	return useStore(store, (s) => s.confirmed);
}
