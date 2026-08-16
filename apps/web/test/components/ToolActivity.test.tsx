import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { groupToolCalls, ToolActivity } from "@/components/ToolActivity.js";
import type { ToolCall } from "@/store/chat";

afterEach(cleanup);

function call(partial: Partial<ToolCall> & { id: string }): ToolCall {
	return {
		name: "search_entities",
		status: "completed",
		...partial,
	};
}

describe("groupToolCalls", () => {
	it("collapses repeated calls of one tool into a single group, args joined in order", () => {
		const groups = groupToolCalls([
			call({ id: "1", arg: "Lev" }),
			call({ id: "2", arg: "Lead Ads" }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].name).toBe("search_entities");
		expect(groups[0].args).toEqual(["Lev", "Lead Ads"]);
		expect(groups[0].overflow).toBe(0);
		expect(groups[0].status).toBe("completed");
	});

	it("caps the visible args at 3 and reports the overflow count", () => {
		const groups = groupToolCalls([
			call({ id: "1", arg: "Lev" }),
			call({ id: "2", arg: "Lead Ads" }),
			call({ id: "3", arg: "Acme" }),
			call({ id: "4", arg: "Globex" }),
			call({ id: "5", arg: "Initech" }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].args).toEqual(["Lev", "Lead Ads", "Acme"]);
		expect(groups[0].overflow).toBe(2);
	});

	it("dedupes identical args within a group", () => {
		const groups = groupToolCalls([
			call({ id: "1", arg: "Lev" }),
			call({ id: "2", arg: "Lev" }),
			call({ id: "3", arg: "Acme" }),
		]);
		expect(groups[0].args).toEqual(["Lev", "Acme"]);
	});

	it("is running if ANY member is still in flight (aggregate status)", () => {
		const groups = groupToolCalls([
			call({ id: "1", arg: "Lev", status: "completed" }),
			call({ id: "2", arg: "Lead Ads", status: "running" }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].status).toBe("running");
	});

	it("breaks an errored call out into its own group, the rest still grouped", () => {
		const groups = groupToolCalls([
			call({ id: "1", arg: "Lev", status: "completed" }),
			call({ id: "2", arg: "Lead Ads", status: "error" }),
			call({ id: "3", arg: "Acme", status: "completed" }),
		]);
		// One grouped row (Lev + Acme) and one errored standalone row (Lead Ads).
		expect(groups).toHaveLength(2);
		const grouped = groups.find((g) => g.status !== "error");
		const errored = groups.find((g) => g.status === "error");
		expect(grouped?.args).toEqual(["Lev", "Acme"]);
		expect(errored?.args).toEqual(["Lead Ads"]);
	});

	it("keeps distinct tools in separate groups, ordered by first occurrence", () => {
		const groups = groupToolCalls([
			call({ id: "1", name: "search_entities", arg: "Lev" }),
			call({ id: "2", name: "load_skill", arg: "grilling" }),
			call({ id: "3", name: "search_entities", arg: "Acme" }),
		]);
		expect(groups.map((g) => g.name)).toEqual([
			"search_entities",
			"load_skill",
		]);
		expect(groups[0].args).toEqual(["Lev", "Acme"]);
		expect(groups[1].args).toEqual(["grilling"]);
	});

	it("handles an argless tool: a group with no args", () => {
		const groups = groupToolCalls([
			call({ id: "1", name: "read_thread", arg: undefined }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].name).toBe("read_thread");
		expect(groups[0].args).toEqual([]);
	});
});

describe("ToolActivity grouped rendering", () => {
	it("renders one row for repeated search calls, with both args", () => {
		render(
			<ToolActivity
				toolCalls={[
					call({ id: "1", arg: "Lev" }),
					call({ id: "2", arg: "Lead Ads" }),
				]}
			/>,
		);
		const rows = screen.getAllByTestId("tool-call");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveTextContent("Searched entities");
		expect(rows[0]).toHaveTextContent("Lev");
		expect(rows[0]).toHaveTextContent("Lead Ads");
	});

	it("renders the errored call as its own row alongside the grouped survivors", () => {
		render(
			<ToolActivity
				toolCalls={[
					call({ id: "1", arg: "Lev", status: "completed" }),
					call({ id: "2", arg: "Lead Ads", status: "error" }),
				]}
			/>,
		);
		const rows = screen.getAllByTestId("tool-call");
		expect(rows).toHaveLength(2);
		const errored = rows.find((r) => r.getAttribute("data-status") === "error");
		expect(errored).toBeDefined();
		expect(errored).toHaveTextContent("Lead Ads");
	});

	it("shows a +N overflow chip past three args", () => {
		render(
			<ToolActivity
				toolCalls={[
					call({ id: "1", arg: "a" }),
					call({ id: "2", arg: "b" }),
					call({ id: "3", arg: "c" }),
					call({ id: "4", arg: "d" }),
				]}
			/>,
		);
		const row = screen.getByTestId("tool-call");
		expect(row).toHaveTextContent("+1");
	});
});

// ── External (`ticktick_*`) calls — external-task-views A4 ──────────────────

const externalResult = (text: string, isError = false) => ({
	content: [{ type: "text" as const, text }],
	is_error: isError,
});

describe("external calls never group", () => {
	it("two same-name external calls stay two rows, keyed by call id, results distinct", () => {
		const groups = groupToolCalls([
			call({
				id: "tc_a",
				name: "ticktick_search_task",
				result: externalResult("first result"),
			}),
			call({
				id: "tc_b",
				name: "ticktick_search_task",
				result: externalResult("second result"),
			}),
		]);
		expect(groups).toHaveLength(2);
		expect(groups.map((g) => g.key)).toEqual(["tc_a", "tc_b"]);
		expect(groups[0].call?.result?.content[0].text).toBe("first result");
		expect(groups[1].call?.result?.content[0].text).toBe("second result");
	});

	it("an external call never merges into a same-position Core group", () => {
		const groups = groupToolCalls([
			call({ id: "1", arg: "Lev" }),
			call({ id: "tc_ext", name: "ticktick_filter_tasks" }),
			call({ id: "2", arg: "Acme" }),
		]);
		// Core calls still merge around it; the external row keeps its slot.
		expect(groups.map((g) => g.key)).toEqual([
			"group:search_entities",
			"tc_ext",
		]);
		expect(groups[1].call?.name).toBe("ticktick_filter_tasks");
	});
});

describe("external expandable row", () => {
	it("renders collapsed, expands to the model-received content, and collapses back", async () => {
		render(
			<ToolActivity
				toolCalls={[
					call({
						id: "tc_ext",
						name: "ticktick_filter_tasks",
						result: externalResult("1 task found: S1 timed"),
					}),
				]}
			/>,
		);
		const row = screen.getByTestId("tool-call");
		expect(row).toHaveAttribute("data-status", "completed");
		// Collapsed by default: the content is NOT in the document.
		expect(screen.queryByTestId("tool-call-result")).toBeNull();

		const toggle = screen.getByRole("button");
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByTestId("tool-call-result")).toHaveTextContent(
			"1 task found: S1 timed",
		);

		await userEvent.click(toggle);
		expect(screen.queryByTestId("tool-call-result")).toBeNull();
	});

	it("an errored external call renders the error row and expands to the error content — identically", async () => {
		render(
			<ToolActivity
				toolCalls={[
					call({
						id: "tc_err",
						name: "ticktick_search_task",
						status: "error",
						result: externalResult("interrupted", true),
					}),
				]}
			/>,
		);
		const row = screen.getByTestId("tool-call");
		expect(row).toHaveAttribute("data-status", "error");
		expect(row).toHaveTextContent("failed");

		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByTestId("tool-call-result")).toHaveTextContent(
			"interrupted",
		);
	});

	it("a running external row is not expandable yet (no result)", () => {
		render(
			<ToolActivity
				toolCalls={[
					call({
						id: "tc_run",
						name: "ticktick_list_projects",
						status: "running",
					}),
				]}
			/>,
		);
		expect(screen.getByRole("button")).toBeDisabled();
		expect(screen.queryByTestId("tool-call-result")).toBeNull();
	});
});
