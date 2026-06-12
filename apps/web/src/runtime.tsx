import { type WsClient, WsClientConfig, WsClientLive } from "@inkstone/ui-sdk";
import { Layer, ManagedRuntime } from "effect";
import { createContext, type ReactNode, useContext, useState } from "react";

/** The single runtime the React tree runs SDK Effects + the stream bridge on. */
export type WsRuntime = ManagedRuntime.ManagedRuntime<WsClient, never>;

/** Derive Core's same-origin WS URL from page location — see docs/design/web-runtime.md. */
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

/** Holds one {@link WsRuntime} for the React tree and exposes it via context — laziness/disposal rationale in docs/design/web-runtime.md. */
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
