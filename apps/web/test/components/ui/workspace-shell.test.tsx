import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceShell } from "@/components/ui/workspace-shell.js";

afterEach(cleanup);

describe("WorkspaceShell", () => {
	it("collapses and reveals the right rail via the bay toggle", async () => {
		const user = userEvent.setup();
		render(
			<WorkspaceShell
				nav={<nav aria-label="Nav">nav</nav>}
				railLabel="activity rail"
				rightRail={<aside aria-label="Activity">activity</aside>}
			>
				<main>content</main>
			</WorkspaceShell>,
		);

		// The accessible name flips between "Close…"/"Open…" so match on the
		// stable suffix; assert state via aria-pressed (jsdom runs no CSS, so
		// width is not observable — ADR-0021).
		const toggle = screen.getByRole("button", { name: /activity rail/i });
		const rail = screen.getByTestId("workspace-right-rail");

		expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect(rail).not.toHaveAttribute("aria-hidden", "true");

		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect(rail).toHaveAttribute("aria-hidden", "true");

		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect(rail).not.toHaveAttribute("aria-hidden", "true");
	});

	it("renders no rail region or toggle when rightRail is omitted", () => {
		render(
			<WorkspaceShell nav={<nav aria-label="Nav">nav</nav>}>
				<main>content</main>
			</WorkspaceShell>,
		);
		expect(
			screen.queryByTestId("workspace-right-rail"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /panel|rail/i }),
		).not.toBeInTheDocument();
	});
});
