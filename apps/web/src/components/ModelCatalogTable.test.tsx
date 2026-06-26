import type { ModelInfo } from "@inkstone/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCatalogTable } from "./ModelCatalogTable.js";

afterEach(cleanup);

function model(
	id: string,
	opts: { reasoning?: boolean; input?: string[] } = {},
): ModelInfo {
	return {
		id,
		name: id,
		reasoning: opts.reasoning ?? false,
		input: opts.input ?? ["text"],
	};
}

describe("ModelCatalogTable", () => {
	it("marks the selected model Preferred and offers Set as preferred on others", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(
			<ModelCatalogTable
				models={[model("alpha"), model("bravo")]}
				selectedId="alpha"
				onSelect={onSelect}
			/>,
		);

		const preferredRow = screen.getByRole("row", { name: /alpha/ });
		expect(within(preferredRow).getByText(/preferred/i)).toBeInTheDocument();

		// Only the non-selected row exposes the action.
		await user.click(screen.getByRole("button", { name: /set as preferred/i }));
		expect(onSelect).toHaveBeenCalledWith("bravo");
	});

	it("shows Reasoning and Vision chips per capability", () => {
		render(
			<ModelCatalogTable
				models={[model("vis", { reasoning: true, input: ["text", "image"] })]}
				selectedId={null}
				onSelect={() => {}}
			/>,
		);
		expect(screen.getByText("Reasoning")).toBeInTheDocument();
		expect(screen.getByText("Vision")).toBeInTheDocument();
	});

	it("omits the Vision chip when image input is unsupported", () => {
		render(
			<ModelCatalogTable
				models={[model("txt", { reasoning: false, input: ["text"] })]}
				selectedId={null}
				onSelect={() => {}}
			/>,
		);
		expect(screen.queryByText("Vision")).toBeNull();
		expect(screen.queryByText("Reasoning")).toBeNull();
	});
});
