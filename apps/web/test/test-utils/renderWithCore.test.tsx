import { WsClient } from "@inkstone/ui-sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cleanup, renderHook, screen } from "@testing-library/react";
import { Cause, Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { useRuntime } from "@/runtime";
import {
	makeCoreRuntime,
	makeCoreWrapper,
	makeQueryClient,
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

	it("an injected queryClient is the one provided — a pre-seeded cache is read on first paint", async () => {
		const injected = makeQueryClient();
		injected.setQueryData(["probe"], "seeded value");
		const Probe = () => {
			const { data } = useQuery<string>({
				queryKey: ["probe"],
				queryFn: () => "fetched",
			});
			return <div>{data}</div>;
		};

		const { queryClient } = await renderWithCore(<Probe />, {
			queryClient: injected,
		});

		expect(queryClient).toBe(injected);
		// The Infinity-stale seeded value serves synchronously (no refetch flash).
		expect(screen.getByText("seeded value")).toBeInTheDocument();
	});

	it("wsConfig mounts ui with a runtime + queryClient handle (the RuntimeProvider config= replacement)", async () => {
		// The real-WsClientLive runtime is LAZY, so nothing dials ws://stub/ws
		// until a verb runs — mounting alone is safe, exactly like the old
		// `<RuntimeProvider config={{ url: "ws://stub/ws" }}>` nesting.
		const { runtime, queryClient } = await renderWithCore(<div>probe</div>, {
			wsConfig: { url: "ws://stub/ws" },
		});

		expect(screen.getByText("probe")).toBeInTheDocument();
		expect(queryClient).toBeDefined();

		// Pin the runtime to the REAL WsClientLive layer: driving a verb dials
		// the dead URL and dies with a connection-shaped first-open defect
		// (`SocketError`, ADR-0020) — NOT stubWsClient's named
		// `Effect.die("WsClient.threadList not stubbed")`, which is what a
		// stub-substituting mutant would produce. jsdom fails the open in
		// milliseconds; the timeout is a guard so a hang would still settle
		// into an assertable failure instead of a suite timeout.
		const exit = await runtime.runPromiseExit(
			Effect.flatMap(WsClient, (ws) => ws.threadList()).pipe(
				Effect.timeout("3 seconds"),
			),
		);
		if (Exit.isSuccess(exit)) {
			throw new Error("expected the dead-URL verb to fail, got success");
		}
		const cause = String(Cause.squash(exit.cause));
		expect(cause).not.toContain("not stubbed");
		expect(cause).toContain("SocketError");
	});
});
