import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
	// tanstackRouter must precede the React plugin: it generates
	// `src/routeTree.gen.ts` from the `src/routes/` tree before React transforms
	// the modules that import it (ADR-0024 settings route).
	plugins: [tanstackRouter({ target: "react" }), react(), tailwindcss()],
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "./src"),
		},
	},
	// Dev only: the SPA opens a same-origin WebSocket (`deriveWsUrl`), so on
	// Vite's dev port `/ws` must be proxied to Core's default listener
	// (ADR-0015 dev path). Production embeds the SPA in Core, so there is no
	// proxy there; the harness serves the built SPA from Core directly.
	server: {
		proxy: {
			"/ws": { target: "ws://127.0.0.1:8765", ws: true },
		},
	},
});
