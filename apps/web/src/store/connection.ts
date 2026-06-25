import type { ConnectionStatus } from "@inkstone/ui-sdk";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * The app-global socket-liveness signal (ADR-0051): the single
 * `connected | reconnecting | disconnected` value the shell's connection
 * indicator renders off. The bridge's {@link startConnectionStream} forks the
 * SDK's `connectionStatus()` stream into this store; components read it via the
 * {@link useConnectionStatus} hook.
 */
interface ConnectionState {
	readonly status: ConnectionStatus;
}

// Plain *vanilla* zustand store so actions are callable outside React render
// (the bridge writes it) — same idiom as chat.ts (ADR-0020).
//
// `connected` is the optimistic default: the socket is open at boot or the
// WsClient Layer build would have died (ADR-0051), and slice-1's SubscriptionRef
// replays the true value on subscribe, so the fork re-asserts the real status
// the instant it starts — the default only ever shows for the boot instant
// before the stream's first emission.
const initialState = (): ConnectionState => ({ status: "connected" });

const store = createStore<ConnectionState>()(() => initialState());

/** Set the current connection status (the bridge's stream writes this). */
export function setConnectionStatus(status: ConnectionStatus): void {
	store.setState({ status });
}

/** Read the raw status (test + bridge use this; components use the hook). */
export function getConnectionStatus(): ConnectionStatus {
	return store.getState().status;
}

/** Reset to the optimistic default (replace mode) — for test isolation. */
export function resetConnectionStore(): void {
	store.setState(initialState(), true);
}

/** Reactive connection status for the shell's liveness indicator (ADR-0051). */
export function useConnectionStatus(): ConnectionStatus {
	return useStore(store, (s) => s.status);
}
