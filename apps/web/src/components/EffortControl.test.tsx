import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EffortControl } from "./EffortControl.js";

afterEach(cleanup);

describe("EffortControl", () => {
	it("marks the active level and reports the picked level", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<EffortControl value="low" onChange={onChange} />);

		expect(
			screen.getByRole("radiogroup", { name: /reasoning effort/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Low" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		expect(screen.getByRole("radio", { name: "Max" })).toHaveAttribute(
			"aria-checked",
			"false",
		);

		await user.click(screen.getByRole("radio", { name: "Max" }));
		expect(onChange).toHaveBeenCalledWith("xhigh");
	});

	it("disables every option when disabled", () => {
		render(<EffortControl value="off" onChange={() => {}} disabled />);
		for (const r of screen.getAllByRole("radio")) {
			expect(r).toBeDisabled();
		}
	});

	it("uses a roving tabindex — only the selected radio is tabbable", () => {
		render(<EffortControl value="medium" onChange={() => {}} />);
		// The selected radio is in the tab order (0); the rest are removed (-1) so
		// one Tab enters the group and arrows move within it (WAI-ARIA radiogroup).
		expect(screen.getByRole("radio", { name: "Medium" })).toHaveAttribute(
			"tabindex",
			"0",
		);
		expect(screen.getByRole("radio", { name: "Off" })).toHaveAttribute(
			"tabindex",
			"-1",
		);
	});

	it("moves the selection with arrow keys and wraps at the ends", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<EffortControl value="low" onChange={onChange} />);

		screen.getByRole("radio", { name: "Low" }).focus();
		// EFFORT_LEVELS = [off, minimal, low, medium, high, xhigh]. From "low",
		// ArrowRight → "medium".
		await user.keyboard("{ArrowRight}");
		expect(onChange).toHaveBeenLastCalledWith("medium");

		// ArrowLeft from "low" → "minimal".
		onChange.mockClear();
		await user.keyboard("{ArrowLeft}");
		expect(onChange).toHaveBeenLastCalledWith("minimal");

		// Home → first ("off"); End → last ("xhigh").
		onChange.mockClear();
		await user.keyboard("{Home}");
		expect(onChange).toHaveBeenLastCalledWith("off");
		await user.keyboard("{End}");
		expect(onChange).toHaveBeenLastCalledWith("xhigh");
	});

	it("wraps arrow navigation at both ends", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		// At the first level, ArrowLeft wraps to the last.
		const { rerender } = render(
			<EffortControl value="off" onChange={onChange} />,
		);
		screen.getByRole("radio", { name: "Off" }).focus();
		await user.keyboard("{ArrowLeft}");
		expect(onChange).toHaveBeenLastCalledWith("xhigh");

		// At the last level, ArrowRight wraps to the first.
		onChange.mockClear();
		rerender(<EffortControl value="xhigh" onChange={onChange} />);
		screen.getByRole("radio", { name: "Max" }).focus();
		await user.keyboard("{ArrowRight}");
		expect(onChange).toHaveBeenLastCalledWith("off");
	});
});
