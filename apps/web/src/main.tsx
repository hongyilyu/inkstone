import { WsClientConfig, WsClientLive } from "@inkstone/ui-sdk";
import { Layer, ManagedRuntime } from "effect";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const wsLayer = Layer.provide(
	WsClientLive,
	Layer.succeed(WsClientConfig, {
		url: "ws://127.0.0.1:8765/ws",
	}),
);

const runtime = ManagedRuntime.make(wsLayer);

const root = document.getElementById("root");

if (!root) {
	throw new Error("Root element #root not found");
}

createRoot(root).render(
	<StrictMode>
		<App runtime={runtime} />
	</StrictMode>,
);
