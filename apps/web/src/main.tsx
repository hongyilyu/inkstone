import { WsClientConfig, WsClientLive } from "@inkstone/ui-sdk";
import { Layer, ManagedRuntime } from "effect";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Left intact for the future re-wiring feature; currently unused by App.
// `void` keeps the construction live without TS' noUnusedLocals tripping.
const wsLayer = Layer.provide(
	WsClientLive,
	Layer.succeed(WsClientConfig, {
		url: "ws://127.0.0.1:8765/ws",
	}),
);
void ManagedRuntime.make(wsLayer);

const root = document.getElementById("root");

if (!root) {
	throw new Error("Root element #root not found");
}

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
