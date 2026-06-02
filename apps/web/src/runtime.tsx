import { type WsClient, WsClientConfig, WsClientLive } from "@inkstone/ui-sdk";
import { Layer, ManagedRuntime } from "effect";
import { createContext, type ReactNode, useContext, useState } from "react";

/** The single runtime the React tree runs SDK Effects + the stream bridge on. */
export type WsRuntime = ManagedRuntime.ManagedRuntime<WsClient, never>;

/**
 * Derive the Core WebSocket URL from the page's location, so a Core-served SPA
 * dials back the same Core that served it — on whatever (possibly ephemeral)
 * port that is. `http:` → `ws:`, `https:` → `wss:`, same host, `/ws` path.
 *
 * In Vite dev the page is served from Vite's port; its `/ws` is proxied to
 * Core (see `vite.config.ts`), so the same-origin URL still reaches Core.
 * Production embeds the SPA in Core, so location IS Core. The harness
 * (ADR-0019) relies on this to avoid hardcoding Core's port in the bundle.
 */
export const deriveWsUrl = (location: {
	readonly protocol: string;
	readonly host: string;
}): string => {
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${location.host}/ws`;
};

/** Build the WS layer: `WsClientLive` provided a concrete `WsClientConfig`. */
export const makeWsLayer = (config: {
	readonly url: string;
}): Layer.Layer<WsClient, never, never> =>
	Layer.provide(WsClientLive, Layer.succeed(WsClientConfig, config));

const RuntimeContext = createContext<WsRuntime | null>(null);

interface RuntimeProviderProps {
	/** Config used to build `WsClientLive` when no `layer`/`runtime` is injected. */
	readonly config?: { readonly url: string };
	/** Injection seam: a pre-built layer (e.g. a stub `WsClient`) for tests. */
	readonly layer?: Layer.Layer<WsClient, never, never>;
	/** Injection seam: a pre-built runtime, used directly when provided. */
	readonly runtime?: WsRuntime;
	readonly children: ReactNode;
}

/**
 * Holds one {@link WsRuntime} for the React tree and exposes it via context.
 *
 * Injection seam (slices 11–13 drive a stub `WsClient` through here):
 *   - `runtime` prop → used directly
 *   - else `layer` prop → `ManagedRuntime.make(layer)`
 *   - else built from `config` (default: same-origin via {@link deriveWsUrl}) via {@link makeWsLayer}
 *
 * Laziness: `ManagedRuntime.make` does NOT run the layer — `WsClientLive` is
 * `Layer.scoped` and only opens the socket when the runtime first RUNS an
 * effect needing `WsClient`. Mounting opens ZERO sockets (we never call
 * `runFork`/`runPromise` here). The runtime is built once per mount via a lazy
 * `useState` initializer so re-renders don't rebuild it.
 *
 * Disposal: not wired here. The runtime is page-lifetime-scoped, and disposing
 * in a `useEffect` cleanup is NOT StrictMode-safe — StrictMode's mount→unmount→
 * remount would dispose the very runtime the persisted `useState` value still
 * holds. Since the runtime is lazy (no socket until an effect runs), an
 * undisposed-yet-unused runtime holds no resources anyway.
 */
export function RuntimeProvider({
	config,
	layer,
	runtime,
	children,
}: RuntimeProviderProps) {
	const [value] = useState<WsRuntime>(() => {
		if (runtime !== undefined) {
			return runtime;
		}
		if (layer !== undefined) {
			return ManagedRuntime.make(layer);
		}
		return ManagedRuntime.make(
			makeWsLayer(config ?? { url: deriveWsUrl(window.location) }),
		);
	});

	return (
		<RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
	);
}

/** Read the {@link WsRuntime} from context; throws when used outside the provider. */
export function useRuntime(): WsRuntime {
	const runtime = useContext(RuntimeContext);
	if (runtime === null) {
		throw new Error("useRuntime must be used within a RuntimeProvider");
	}
	return runtime;
}
