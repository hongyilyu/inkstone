import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StubTopic } from "./StubTopic.js";

afterEach(cleanup);

describe("StubTopic", () => {
	it("renders the title, the coming-soon line, and a link to the tracking issue", () => {
		render(
			<StubTopic
				title="Health"
				description="Your observation streams will land here."
				issue={253}
			/>,
		);

		expect(screen.getByText("Health")).toBeInTheDocument();
		expect(
			screen.getByText("Your observation streams will land here."),
		).toBeInTheDocument();

		const link = screen.getByRole("link");
		expect(link).toHaveAttribute("href", expect.stringContaining("253"));
		expect(link).toHaveAttribute("href", expect.stringContaining("/issues/"));
	});

	it("points the issue link at the topic's own tracking number", () => {
		render(
			<StubTopic
				title="Media"
				description="Your read/watch queue will land here."
				issue={252}
			/>,
		);

		const link = screen.getByRole("link");
		expect(link).toHaveAttribute("href", expect.stringContaining("252"));
	});
});
