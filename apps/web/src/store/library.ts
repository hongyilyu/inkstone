import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** Local, non-durable UI state for the Library (VISUAL ONLY; resets on reload). */
interface LibraryState {
	/** Library item ids the user has confirmed out of the "Needs review" digest. */
	confirmed: Record<string, true>;
}

const store = createStore<LibraryState>()(() => ({
	confirmed: {},
}));

export function confirmReview(id: string): void {
	store.setState((s) => ({ ...s, confirmed: { ...s.confirmed, [id]: true } }));
}

/** Reset to empty — for test isolation. */
export function resetLibraryStore(): void {
	store.setState({ confirmed: {} });
}

export function useConfirmedReviews(): Record<string, true> {
	return useStore(store, (s) => s.confirmed);
}
