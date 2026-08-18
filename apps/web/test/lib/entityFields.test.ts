import { describe, expect, it } from "vitest";
import {
	asProjectStatus,
	PROJECT_STATUS_OPTIONS,
	parseAliases,
} from "@/lib/entityFields";

describe("entityFields — single-source entity field surface", () => {
	describe("parseAliases", () => {
		it("splits on comma, trims, drops empties", () => {
			expect(parseAliases("a, ,b ,")).toEqual(["a", "b"]);
		});
		it("returns [] for an empty string", () => {
			expect(parseAliases("")).toEqual([]);
		});
		it("returns [] for whitespace-only", () => {
			expect(parseAliases("  ")).toEqual([]);
		});
		it("returns the single trimmed token", () => {
			expect(parseAliases("x")).toEqual(["x"]);
		});
	});

	describe("asProjectStatus — degrade to default", () => {
		it("passes on_hold/completed/dropped verbatim", () => {
			expect(asProjectStatus("on_hold")).toBe("on_hold");
			expect(asProjectStatus("completed")).toBe("completed");
			expect(asProjectStatus("dropped")).toBe("dropped");
		});
		it("degrades active and everything else to active", () => {
			expect(asProjectStatus("active")).toBe("active");
			expect(asProjectStatus(undefined)).toBe("active");
			expect(asProjectStatus(null)).toBe("active");
			expect(asProjectStatus("garbage")).toBe("active");
			expect(asProjectStatus(42)).toBe("active");
		});
	});

	describe("option arrays — exact {value,label} pairs in order", () => {
		it("Project status options", () => {
			expect(PROJECT_STATUS_OPTIONS).toEqual([
				{ value: "active", label: "Active" },
				{ value: "on_hold", label: "On hold" },
				{ value: "completed", label: "Completed" },
				{ value: "dropped", label: "Dropped" },
			]);
		});
	});
});
