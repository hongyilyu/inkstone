import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** Open-state for the global command palette (⌘K); a tiny vanilla store driven without prop threading (ADR-0020). */
interface CommandState {
	open: boolean;
}

const store = createStore<CommandState>()(() => ({ open: false }));

export function openCommand(): void {
	store.setState({ open: true });
}

export function closeCommand(): void {
	store.setState({ open: false });
}

export function toggleCommand(): void {
	store.setState((s) => ({ open: !s.open }));
}

/** Reset to closed — for test isolation. */
export function resetCommandStore(): void {
	store.setState({ open: false });
}

export function useCommandOpen(): boolean {
	return useStore(store, (s) => s.open);
}
