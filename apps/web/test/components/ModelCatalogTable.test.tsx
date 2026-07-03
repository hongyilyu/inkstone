import type { ModelInfo } from "@inkstone/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCatalogTable } from "@/components/ModelCatalogTable.js";

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
				providerLabel="OpenAI"
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
				providerLabel="OpenAI"
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
				providerLabel="OpenAI"
			/>,
		);
		expect(screen.queryByText("Vision")).toBeNull();
		expect(screen.queryByText("Reasoning")).toBeNull();
	});

	it("locks the current default's enable toggle (disabled + hint) so it can't be disabled", () => {
		render(
			<ModelCatalogTable
				models={[model("alpha"), model("bravo")]}
				selectedId="alpha"
				onSelect={() => {}}
				providerLabel="OpenAI"
				enabledIds={["alpha", "bravo"]}
				onToggleEnabled={() => {}}
			/>,
		);

		const defaultRow = screen.getByRole("row", { name: /alpha/ });
		const toggle = within(defaultRow).getByRole("checkbox", {
			name: /enabled for chat/i,
		});
		// The default model is always enabled and its toggle is locked.
		expect(toggle).toBeChecked();
		expect(toggle).toBeDisabled();
		expect(toggle).toHaveAccessibleDescription(/another model as default/i);
	});

	it("toggles a non-default model via onToggleEnabled", async () => {
		const user = userEvent.setup();
		const onToggleEnabled = vi.fn();
		render(
			<ModelCatalogTable
				models={[model("alpha"), model("bravo")]}
				selectedId="alpha"
				onSelect={() => {}}
				providerLabel="OpenAI"
				enabledIds={["alpha", "bravo"]}
				onToggleEnabled={onToggleEnabled}
			/>,
		);

		const otherRow = screen.getByRole("row", { name: /bravo/ });
		const toggle = within(otherRow).getByRole("checkbox", {
			name: /enabled for chat/i,
		});
		expect(toggle).toBeChecked();
		expect(toggle).not.toBeDisabled();

		await user.click(toggle);
		// Currently enabled → toggling targets `false`.
		expect(onToggleEnabled).toHaveBeenCalledWith("bravo", false);
	});

	it("treats an empty enabledIds as 'all enabled' (every toggle checked)", () => {
		render(
			<ModelCatalogTable
				models={[model("alpha"), model("bravo")]}
				selectedId="alpha"
				onSelect={() => {}}
				providerLabel="OpenAI"
				enabledIds={[]}
				onToggleEnabled={() => {}}
			/>,
		);
		for (const name of ["alpha", "bravo"]) {
			const row = screen.getByRole("row", { name: new RegExp(name) });
			expect(
				within(row).getByRole("checkbox", { name: /enabled for chat/i }),
			).toBeChecked();
		}
	});

	it("groups rows under vendor headers and strips the redundant vendor prefix from names", () => {
		const named = (id: string, name: string): ModelInfo => ({
			id,
			name,
			reasoning: false,
			input: ["text"],
		});
		render(
			<ModelCatalogTable
				models={[
					named("openai/gpt-5.5", "OpenAI: GPT-5.5"),
					named("anthropic/claude-opus-4.8", "Anthropic: Claude Opus 4.8"),
					named("openai/gpt-5.5-pro", "OpenAI: GPT-5.5 Pro"),
				]}
				selectedId={null}
				onSelect={() => {}}
				providerLabel="OpenRouter"
			/>,
		);

		// Both vendors appear as colgroup headers.
		expect(
			screen.getByRole("columnheader", { name: "OpenAI" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("columnheader", { name: "Anthropic" }),
		).toBeInTheDocument();

		// The "Vendor: " prefix is stripped from the row name (grouped under the header).
		expect(screen.getByText("GPT-5.5")).toBeInTheDocument();
		expect(screen.getByText("Claude Opus 4.8")).toBeInTheDocument();
		expect(screen.queryByText("OpenAI: GPT-5.5")).toBeNull();
	});
});
