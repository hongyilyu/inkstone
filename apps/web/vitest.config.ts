import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "./src"),
			"@test": path.resolve(import.meta.dirname, "./test"),
		},
	},
	test: {
		environment: "jsdom",
		setupFiles: ["./test/test-setup.ts"],
		exclude: ["**/node_modules/**", "**/dist/**"],
	},
});
