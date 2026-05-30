import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App.js";

describe("App", () => {
	it("renders the three-region shell", () => {
		render(<App />);
		expect(
			screen.getByRole("complementary", { name: /sidebar/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("main")).toBeInTheDocument();
		expect(
			screen.getByRole("complementary", { name: /activity/i }),
		).toBeInTheDocument();
	});
});
