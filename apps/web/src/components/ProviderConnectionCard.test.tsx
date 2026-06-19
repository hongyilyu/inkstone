import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderConnectionCard } from "./ProviderConnectionCard.js";

afterEach(cleanup);

describe("ProviderConnectionCard", () => {
	it("shows Connected with a check icon and no hue when connected", () => {
		const { container } = render(
			<ProviderConnectionCard
				name="ChatGPT"
				connected={true}
				onConnect={() => {}}
			/>,
		);
		expect(screen.getByTestId("provider-status")).toHaveTextContent(
			"Connected",
		);
		// "Connected" appears both as status text and as the trailing pill word.
		expect(screen.getAllByText("Connected").length).toBeGreaterThanOrEqual(1);
		// lucide Check renders an inline svg.
		expect(container.querySelector("svg")).not.toBeNull();
		expect(container.querySelector('[class*="emerald"]')).toBeNull();
	});

	it("offers a Connect button when not connected", () => {
		render(
			<ProviderConnectionCard
				name="ChatGPT"
				connected={false}
				onConnect={() => {}}
			/>,
		);
		expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
		expect(screen.getByTestId("provider-status")).toHaveTextContent(
			"Not connected",
		);
	});

	it("shows Checking… while the status query is in flight", () => {
		render(
			<ProviderConnectionCard
				name="ChatGPT"
				connected={null}
				onConnect={() => {}}
			/>,
		);
		expect(screen.getByTestId("provider-status")).toHaveTextContent(
			"Checking…",
		);
		expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
	});
});
