import type {
	ObservationUpdateParams,
	ObservationUpdateResult,
} from "@inkstone/protocol";
import { type WsError, WsRequestError } from "@inkstone/ui-sdk";
import { makeCoreWrapper } from "@test/test-utils/renderWithCore";
import { renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useObservationUpdate } from "@/lib/hooks/useObservationUpdate";
import { currentCue, resetEntityCueStore } from "@/store/entityCue";

// Stub WsClient whose `observationUpdate` runs the provided handler; other
// un-stubbed request verbs die, while the harness serves empty
// entity/backlink/run-event reads.
function makeWrapper(
	observationUpdate: (
		params: ObservationUpdateParams,
	) => Effect.Effect<ObservationUpdateResult, WsError>,
) {
	return makeCoreWrapper({ overrides: { observationUpdate } });
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
		const { wrapper, queryClient } = makeWrapper((p) => {
			seen.push(p);
			return Effect.succeed({ observation_id: p.observation_id });
		});
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useObservationUpdate(), {
			wrapper,
		});

		result.current.mutate(params);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(seen).toEqual([params]);
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["observations"] });
	});

	it("fires the 'Saved' cue on a successful correction", async () => {
		const { wrapper } = makeWrapper((p) =>
			Effect.succeed({ observation_id: p.observation_id }),
		);

		const { result } = renderHook(() => useObservationUpdate(), {
			wrapper,
		});

		result.current.mutate(params);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(currentCue()?.verb).toBe("Saved");
	});

	it("fires NO cue when the correction fails", async () => {
		const { wrapper } = makeWrapper(() =>
			Effect.fail(new WsRequestError({ reason: "boom" })),
		);
		resetEntityCueStore();

		const { result } = renderHook(() => useObservationUpdate(), {
			wrapper,
		});

		result.current.mutate(params);

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(currentCue()).toBeNull();
	});

	// The mutation must reject with the ORIGINAL WsError, not Effect's FiberFailure
	// wrapper (mirrors the sibling useEntityMutation test's rationale).
	it("rejects with the original WsRequestError, not a FiberFailure wrapper", async () => {
		const { wrapper } = makeWrapper(() =>
			Effect.fail(new WsRequestError({ reason: "boom" })),
		);

		const { result } = renderHook(() => useObservationUpdate(), {
			wrapper,
		});

		result.current.mutate(params);

		await waitFor(() => expect(result.current.isError).toBe(true));
		const error = result.current.error;
		expect(error).toBeInstanceOf(WsRequestError);
		expect((error as WsRequestError).reason).toBe("boom");
		expect((error as Error).message).not.toBe("An error has occurred");
	});
});
