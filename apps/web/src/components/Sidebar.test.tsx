import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { automations, history } from "../data/mock.js";
import { Sidebar } from "./Sidebar.js";

describe("Sidebar", () => {
	it("groups runs into Today / This week / Older and toggles Automations", async () => {
		const user = userEvent.setup();
		render(<Sidebar />);

		// First mock history entry is the running run → "Today"
		expect(screen.getByText(/Today/i)).toBeInTheDocument();
		expect(screen.getByText(history[0].prompt)).toBeInTheDocument();

		// history[1..3] under "This week"
		expect(screen.getByText(/This week/i)).toBeInTheDocument();
		expect(screen.getByText(history[1].prompt)).toBeInTheDocument();

		// history[4..] under "Older"
		expect(screen.getByText(/Older/i)).toBeInTheDocument();

		// Automations folder is closed initially — names not in DOM
		const trigger = screen.getByRole("button", { name: /Automations/i });
		expect(trigger).toBeInTheDocument();
		expect(screen.queryByText(automations[0].name)).not.toBeInTheDocument();

		// Click to open — automation names appear
		await user.click(trigger);
		expect(screen.getByText(automations[0].name)).toBeInTheDocument();
	});
});
