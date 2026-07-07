import { WsClient } from "@inkstone/ui-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { cleanup, renderHook, screen } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { useRuntime } from "@/runtime";
import {
	makeCoreRuntime,
	makeCoreWrapper,
	renderWithCore,
} from "./renderWithCore";
import { todoRow } from "./rows";

afterEach(cleanup);

describe("renderWithCore harness", () => {
	it("serves seeded entities by type and returns empty for unlisted types", async () => {
		const runtime = makeCoreRuntime({
			entities: { todo: [todoRow("t1", "Buy milk")] },
		});

		const todos = await runtime.runPromise(
			Effect.flatMap(WsClient, (ws) => ws.listEntities("todo")),
		);
		expect(todos.entities.map((e) => e.id)).toEqual(["t1"]);

		const projects = await runtime.runPromise(
			Effect.flatMap(WsClient, (ws) => ws.listEntities("project")),
		);
		expect(projects.entities).toEqual([]);
	});

	it("un-seeded verb still dies with the named cause", async () => {
		const runtime = makeCoreRuntime();

		await expect(
			runtime.runPromise(
				Effect.flatMap(WsClient, (ws) => ws.threadCreate("hello")),
			),
		).rejects.toThrow("WsClient.threadCreate not stubbed");
	});

	it("overrides beat a seeded listEntities", async () => {
		const runtime = makeCoreRuntime({
			entities: { todo: [todoRow("seeded", "Loser")] },
			overrides: {
				listEntities: () =>
					Effect.succeed({ entities: [todoRow("winner", "Winner")] }),
			},
		});

		const result = await runtime.runPromise(
			Effect.flatMap(WsClient, (ws) => ws.listEntities("todo")),
		);
		expect(result.entities.map((e) => e.id)).toEqual(["winner"]);
	});

	it("path mounts a memory router at the given location", async () => {
		const { router } = await renderWithCore(<div>probe</div>, {
			path: "/thread/t1",
		});

		expect(router?.state.location.pathname).toBe("/thread/t1");
		expect(screen.getByText("probe")).toBeInTheDocument();
	});

	it("makeCoreWrapper provides runtime+queryClient for renderHook", () => {
		const { wrapper, runtime, queryClient } = makeCoreWrapper();

		const { result } = renderHook(
			() => ({ runtime: useRuntime(), queryClient: useQueryClient() }),
			{ wrapper },
		);

		expect(result.current.runtime).toBe(runtime);
		expect(result.current.queryClient).toBe(queryClient);
	});
});
