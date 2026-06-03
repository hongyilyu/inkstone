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
});
