import type {
	ObservationUpdateParams,
	ObservationUpdateResult,
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
import { useObservationUpdate } from "./useObservationUpdate";

// Stub WsClient whose `observationUpdate` runs the provided handler; unused methods die.
function makeRuntime(
	observationUpdate: (
		params: ObservationUpdateParams,
	) => Effect.Effect<ObservationUpdateResult, WsError>,
) {
	const stub = stubWsClient({ observationUpdate });
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

const params: ObservationUpdateParams = {
	observation_id: "01900000-0000-7000-8000-000000000099",
	observation: {
		occurred_at: "2026-06-10T07:00:00",
		values: { kg: 71.8 },
	},
};

describe("useObservationUpdate", () => {
	afterEach(() => resetEntityCueStore());

	it("calls observationUpdate with the exact params and invalidates observations on success", async () => {
		const seen: ObservationUpdateParams[] = [];
		const runtime = makeRuntime((p) => {
			seen.push(p);
			return Effect.succeed({ observation_id: p.observation_id });
		});
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useObservationUpdate(), {
			wrapper: makeWrapper(runtime, queryClient),
		});

		result.current.mutate(params);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(seen).toEqual([params]);
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["observations"] });
	});

	it("fires the 'Saved' cue on a successful correction", async () => {
		const runtime = makeRuntime((p) =>
			Effect.succeed({ observation_id: p.observation_id }),
		);
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(() => useObservationUpdate(), {
			wrapper: makeWrapper(runtime, queryClient),
		});

		result.current.mutate(params);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(currentCue()?.verb).toBe("Saved");
	});

	it("fires NO cue when the correction fails", async () => {
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

		const { result } = renderHook(() => useObservationUpdate(), {
			wrapper: makeWrapper(runtime, queryClient),
		});

		result.current.mutate(params);

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(currentCue()).toBeNull();
	});

	// The mutation must reject with the ORIGINAL WsError, not Effect's FiberFailure
	// wrapper (mirrors the sibling useEntityMutation test's rationale).
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

		const { result } = renderHook(() => useObservationUpdate(), {
			wrapper: makeWrapper(runtime, queryClient),
		});

		result.current.mutate(params);

		await waitFor(() => expect(result.current.isError).toBe(true));
		const error = result.current.error;
		expect(error).toBeInstanceOf(WsRequestError);
		expect((error as WsRequestError).reason).toBe("boom");
		expect((error as Error).message).not.toBe("An error has occurred");
	});
});
