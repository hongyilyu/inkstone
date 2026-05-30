import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { automationRuns } from "@/data/mock/automations";
import { proposals } from "@/data/mock/proposals";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import { ActivityRail } from "./ActivityRail.js";

describe("ActivityRail", () => {
	it("groups rows into Today/Yesterday/Earlier and filter pill hides automations", async () => {
		const user = userEvent.setup();
		renderWithQuery(<ActivityRail />);

		// Three section headers visible.
		expect(screen.getByText(/^Today$/i)).toBeInTheDocument();
		expect(screen.getByText(/^Yesterday$/i)).toBeInTheDocument();
		expect(screen.getByText(/^Earlier$/i)).toBeInTheDocument();

		// Edit row from a proposal (clock-only timestamp → classified today).
		expect(screen.getByText(proposals[0].title)).toBeInTheDocument();

		// Automation summary appears initially.
		const autoSummary = automationRuns[0].summary;
		expect(screen.getByText(autoSummary)).toBeInTheDocument();

		// Click the Edits filter pill.
		await user.click(screen.getByRole("button", { name: /edits/i }));

		// Automation summary is now hidden.
		expect(screen.queryByText(autoSummary)).not.toBeInTheDocument();

		// Edit row text remains.
		expect(screen.getByText(proposals[0].title)).toBeInTheDocument();
	});
});
