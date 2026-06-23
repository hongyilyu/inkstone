import { describe, expect, it } from "vitest";
import {
	asProjectStatus,
	asTodoStatus,
	PROJECT_STATUS_LABEL,
	PROJECT_STATUS_OPTIONS,
	parseAliases,
	RECUR_ANCHOR_OPTIONS,
	RECURRENCE_UNIT_OPTIONS,
	TODO_STATUS_LABEL,
	TODO_STATUS_OPTIONS,
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

	describe("asTodoStatus — degrade to default", () => {
		it("passes completed/dropped verbatim", () => {
			expect(asTodoStatus("completed")).toBe("completed");
			expect(asTodoStatus("dropped")).toBe("dropped");
		});
		it("degrades active and everything else to active", () => {
			expect(asTodoStatus("active")).toBe("active");
			expect(asTodoStatus(undefined)).toBe("active");
			expect(asTodoStatus(null)).toBe("active");
			expect(asTodoStatus("garbage")).toBe("active");
			expect(asTodoStatus(42)).toBe("active");
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
		it("Todo status options", () => {
			expect(TODO_STATUS_OPTIONS).toEqual([
				{ value: "active", label: "Active" },
				{ value: "completed", label: "Completed" },
				{ value: "dropped", label: "Dropped" },
			]);
		});
		it("Project status options", () => {
			expect(PROJECT_STATUS_OPTIONS).toEqual([
				{ value: "active", label: "Active" },
				{ value: "on_hold", label: "On hold" },
				{ value: "completed", label: "Completed" },
				{ value: "dropped", label: "Dropped" },
			]);
		});
		it("Recurrence unit options", () => {
			expect(RECURRENCE_UNIT_OPTIONS).toEqual([
				{ value: "minute", label: "Minutes" },
				{ value: "hour", label: "Hours" },
				{ value: "day", label: "Days" },
				{ value: "week", label: "Weeks" },
				{ value: "month", label: "Months" },
				{ value: "year", label: "Years" },
			]);
		});
		it("Recur anchor options", () => {
			expect(RECUR_ANCHOR_OPTIONS).toEqual([
				{ value: "defer_at", label: "Defer date" },
				{ value: "due_at", label: "Due date" },
			]);
		});
	});

	describe("derived *_STATUS_LABEL maps", () => {
		it("TODO_STATUS_LABEL equals the literals", () => {
			expect(TODO_STATUS_LABEL).toEqual({
				active: "Active",
				completed: "Completed",
				dropped: "Dropped",
			});
		});
		it("PROJECT_STATUS_LABEL equals the literals", () => {
			expect(PROJECT_STATUS_LABEL).toEqual({
				active: "Active",
				on_hold: "On hold",
				completed: "Completed",
				dropped: "Dropped",
			});
		});
	});
});
