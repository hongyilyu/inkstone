import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { history } from "@/data/mock/history";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import { Sidebar } from "./Sidebar.js";

describe("Sidebar", () => {
	it("renders t3 layout: top bar, New Chat, search, Last 30 Days, threads", () => {
		renderWithQuery(<Sidebar />);

		expect(
			screen.getByRole("button", { name: /new chat/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("textbox", { name: /search/i }),
		).toBeInTheDocument();
		expect(screen.getByText(/Last 30 Days/i)).toBeInTheDocument();
		expect(screen.getByText(history[0].prompt)).toBeInTheDocument();
	});
});
