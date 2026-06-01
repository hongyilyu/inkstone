import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import App from "./App.js";
import { RuntimeProvider } from "./runtime.js";

describe("App", () => {
	it("renders the three-region shell", () => {
		// ChatColumn + Sidebar now call useRuntime(), so App's tree requires a
		// RuntimeProvider (main.tsx wraps it; this test does the same). A stub url
		// opens no socket at mount — the runtime is lazy and this test never sends
		// or reads (the threadList query stays pending, which renders an empty
		// sidebar, not a throw).
		renderWithQuery(
			<RuntimeProvider config={{ url: "ws://stub/ws" }}>
				<App />
			</RuntimeProvider>,
		);
		expect(
			screen.getByRole("complementary", { name: /sidebar/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("main")).toBeInTheDocument();
		expect(
			screen.getByRole("complementary", { name: /activity/i }),
		).toBeInTheDocument();
	});
});
