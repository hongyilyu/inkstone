import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { WelcomeBanner } from "./WelcomeBanner.js";

describe("WelcomeBanner", () => {
	afterEach(() => cleanup());

	it("renders welcome copy and dismisses on click", async () => {
		const user = userEvent.setup();
		render(<WelcomeBanner />);
		expect(screen.getByText(/welcome/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /dismiss/i }));
		expect(screen.queryByText(/welcome/i)).not.toBeInTheDocument();
	});
});
