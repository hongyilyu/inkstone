import type { ModelInfo } from "@inkstone/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModelCatalogTable } from "./ModelCatalogTable.js";

afterEach(cleanup);

function model(id: string, cost_output: number): ModelInfo {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost_input: 0,
		cost_output,
	};
}

describe("ModelCatalogTable cost badge", () => {
	const tiers = [
		{ id: "free", cost: 0, label: "Free", glyph: "$0", count: 1 },
		{ id: "low", cost: 2, label: "Low cost", glyph: "$", count: 1 },
		{ id: "medium", cost: 10, label: "Medium cost", glyph: "$", count: 2 },
		{ id: "high", cost: 30, label: "High cost", glyph: "$", count: 3 },
	];

	for (const tier of tiers) {
		it(`exposes "${tier.label}" with the right glyph at cost ${tier.cost}`, () => {
			render(
				<ModelCatalogTable
					models={[model(tier.id, tier.cost)]}
					selectedId={null}
					onSelect={() => {}}
				/>,
			);
			const badge = screen.getByRole("img", { name: tier.label });
			if (tier.glyph === "$0") {
				expect(badge).toHaveTextContent("$0");
			} else {
				expect(badge.textContent).toBe("$".repeat(tier.count));
			}
		});
	}

	it("uses no emerald/amber/rose hue on any cost tier", () => {
		const { container } = render(
			<ModelCatalogTable
				models={tiers.map((t) => model(t.id, t.cost))}
				selectedId={null}
				onSelect={() => {}}
			/>,
		);
		expect(container.querySelector('[class*="emerald"]')).toBeNull();
		expect(container.querySelector('[class*="amber"]')).toBeNull();
		expect(container.querySelector('[class*="rose"]')).toBeNull();
	});
});
