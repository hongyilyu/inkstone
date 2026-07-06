import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
	// tanstackRouter must precede React: it generates routeTree.gen.ts before React transforms importers (ADR-0024). Route tests are excluded.
	plugins: [
		tanstackRouter({
			target: "react",
			routeFileIgnorePattern: ".*\\.test\\.tsx?$",
		}),
		react(),
		tailwindcss(),
	],
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "./src"),
		},
	},
	// Dev only: proxy same-origin `/ws` (ADR-0015) and `GET /media/{id}` (ADR-0058)
	// to Core's listener; production embeds the SPA in Core with no proxy.
	server: {
		proxy: {
			"/ws": { target: "ws://127.0.0.1:8765", ws: true },
			"/media": { target: "http://127.0.0.1:8765" },
		},
	},
});
