import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposeFooter } from "./ComposeFooter.js";

describe("ComposeFooter", () => {
	it("calls onSend with the typed text on click and renders model/token strip", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(<ComposeFooter onSend={onSend} />);

		await user.type(screen.getByRole("textbox"), "hello");
		await user.click(screen.getByRole("button", { name: /send/i }));

		expect(onSend).toHaveBeenCalledTimes(1);
		expect(onSend).toHaveBeenCalledWith("hello");

		// Model picker trigger shows the model name; full label is in the dropdown.
		expect(
			screen.getByRole("button", { name: /Select model/i }),
		).toBeInTheDocument();
		expect(screen.getByText(/gemma-3 27b/i)).toBeInTheDocument();
		expect(screen.getByText(/4,812/)).toBeInTheDocument();
	});
});
