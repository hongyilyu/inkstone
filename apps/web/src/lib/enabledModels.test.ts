import { describe, expect, it } from "vitest";
import { filterEnabledModels, isModelEnabled } from "./enabledModels.js";

describe("enabledModels membership (ADR-0024)", () => {
	it("empty set is uncurated — everything is enabled", () => {
		expect(isModelEnabled([], "gpt-5.5")).toBe(true);
		const models = [{ id: "a" }, { id: "b" }];
		expect(filterEnabledModels(models, [])).toBe(models);
	});

	it("a non-empty set enables only its members", () => {
		expect(isModelEnabled(["gpt-5.5"], "gpt-5.5")).toBe(true);
		expect(isModelEnabled(["gpt-5.5"], "gpt-5.4-mini")).toBe(false);
		expect(filterEnabledModels([{ id: "a" }, { id: "b" }], ["a"])).toEqual([
			{ id: "a" },
		]);
	});
});
