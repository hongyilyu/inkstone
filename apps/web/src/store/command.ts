import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * Open-state for the global command palette (⌘K). A tiny vanilla store so the
 * keyboard handler (mounted once in `__root`) and any in-tree trigger (the
 * Library nav button) can drive the same overlay without prop threading —
 * matching the zustand-vanilla pattern in `store/chat.ts` (ADR-0020).
 */
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
