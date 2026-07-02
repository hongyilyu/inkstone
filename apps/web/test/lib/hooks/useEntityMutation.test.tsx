import type {
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import {
	stubWsClient,
	WsClient,
	type WsError,
	WsRequestError,
} from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { currentCue, resetEntityCueStore } from "@/store/entityCue";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";

// Stub WsClient whose `entityMutate` runs the provided handler; unused methods die.
function makeRuntime(
	entityMutate: (
		params: EntityMutateParams,
	) => Effect.Effect<EntityMutateResult, WsError>,
) {
	const stub = stubWsClient({ entityMutate });
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

function makeWrapper(
	runtime: ReturnType<typeof makeRuntime>,
	client: QueryClient,
) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
		</QueryClientProvider>
	);
}

describe("useEntityMutation", () => {
	// `showEntityCue` arms a real 2500ms dismiss timer; clear the slot + timer after
	// each case so a cue (and its pending timer) never bleeds into the next test.
	afterEach(() => resetEntityCueStore());

	it("calls entityMutate and invalidates library-items on success", async () => {
		const seen: EntityMutateParams[] = [];
		const runtime = makeRuntime((params) => {
			seen.push(params);
			return Effect.succeed({
				entity_id: "01900000-0000-7000-8000-000000000020",
			});
		});
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useEntityMutation(), {
			wrapper: makeWrapper(runtime, queryClient),
		});

		result.current.mutate({
			mutation_kind: "create_person",
			payload: { name: "A" },
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(seen).toEqual([
			{ mutation_kind: "create_person", payload: { name: "A" } },
		]);
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["library-items"] });
		expect(result.current.data).toEqual({
			entity_id: "01900000-0000-7000-8000-000000000020",
		});
	});

	// The mutation must reject with the ORIGINAL WsError, not Effect's FiberFailure
	// wrapper. A WsRequestError's `.message` is "" (its text lives in `.reason`); the
	// FiberFailure wrapper would replace that with the generic "An error has occurred",
	// which callers reading `error.message` would then surface as user copy.
	it("rejects with the original WsRequestError, not a FiberFailure wrapper", async () => {
		const runtime = makeRuntime(() =>
			Effect.fail(new WsRequestError({ reason: "boom" })),
		);
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});

		const { result } = renderHook(() => useEntityMutation(), {
			wrapper: makeWrapper(runtime, queryClient),
		});

		result.current.mutate({
			mutation_kind: "create_person",
			payload: { name: "A" },
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		const error = result.current.error;
		expect(error).toBeInstanceOf(WsRequestError);
		expect((error as WsRequestError).reason).toBe("boom");
		// Not Effect's generic FiberFailure message.
		expect((error as Error).message).not.toBe("An error has occurred");
	});

	it("fires the 'Created' cue on a successful create", async () => {
		const runtime = makeRuntime(() =>
			Effect.succeed({ entity_id: "01900000-0000-7000-8000-000000000020" }),
		);
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(() => useEntityMutation(), {
			wrapper: makeWrapper(runtime, queryClient),
		});

		result.current.mutate({
			mutation_kind: "create_todo",
			payload: { title: "A" },
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		// Read synchronously — the 2500ms dismiss hasn't fired yet.
		expect(currentCue()?.verb).toBe("Created");
	});

	// Proves the single hook-level chokepoint also covers delete: no EntityDetail edit.
	it("fires the 'Deleted' cue on a successful delete", async () => {
		const runtime = makeRuntime(() =>
			Effect.succeed({ entity_id: "01900000-0000-7000-8000-000000000020" }),
		);
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(() => useEntityMutation(), {
			wrapper: makeWrapper(runtime, queryClient),
		});

		result.current.mutate({
			mutation_kind: "delete_todo",
			payload: { entity_id: "01900000-0000-7000-8000-000000000020" },
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(currentCue()?.verb).toBe("Deleted");
	});

	// The cue lives only in onSuccess — a rejected mutation must leave the slot empty.
	it("fires NO cue when the mutation fails", async () => {
		const runtime = makeRuntime(() =>
			Effect.fail(new WsRequestError({ reason: "boom" })),
		);
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		resetEntityCueStore();

		const { result } = renderHook(() => useEntityMutation(), {
			wrapper: makeWrapper(runtime, queryClient),
		});

		result.current.mutate({
			mutation_kind: "create_todo",
			payload: { title: "A" },
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(currentCue()).toBeNull();
	});
});
