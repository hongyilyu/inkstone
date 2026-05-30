import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { queue } from "../data/mock.js";
import { QueueBanner } from "./QueueBanner.js";

describe("QueueBanner", () => {
	it("advances to the next queue item on keyboard 1", async () => {
		const user = userEvent.setup();
		render(<QueueBanner />);

		// First item visible
		expect(screen.getByText(queue[0].pendingTitle)).toBeInTheDocument();
		expect(screen.queryByText(queue[1].pendingTitle)).not.toBeInTheDocument();

		// Press 1
		await user.keyboard("1");

		// After leave/enter transition, second item is visible
		await waitFor(
			() => expect(screen.getByText(queue[1].pendingTitle)).toBeInTheDocument(),
			{ timeout: 1000 },
		);
		expect(screen.queryByText(queue[0].pendingTitle)).not.toBeInTheDocument();
	});
});
