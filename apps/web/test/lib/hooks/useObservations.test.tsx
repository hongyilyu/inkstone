import type { ObservationRow } from "@inkstone/protocol";
import { type WsClient, WsRequestError } from "@inkstone/ui-sdk";
import { makeCoreWrapper } from "@test/test-utils/renderWithCore";
import { renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	assembleObservationItems,
	useObservations,
} from "@/lib/hooks/useObservations.js";

const row = (
	over: Partial<ObservationRow> & Pick<ObservationRow, "schema_key" | "values">,
): ObservationRow => ({
	id: "obs-1",
	schema_version: 1,
	occurred_at: "2026-06-10T09:00:00",
	ended_at: null,
	note: null,
	source: null,
	created_at: 1000,
	updated_at: 1000,
	...over,
});

describe("assembleObservationItems", () => {
	it("maps each row through toObservationView", () => {
		const items = assembleObservationItems([
			row({ id: "bw", schema_key: "bodyweight", values: { kg: 72.4 } }),
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("bw");
		expect(items[0]?.summary).toContain("72.4 kg");
	});

	it("an empty observation list yields []", () => {
		expect(assembleObservationItems([])).toEqual([]);
	});
});

// A WsClient stub whose `observationQuery` runs the supplied handler; the rest die.
function makeWrapper(observationQuery: WsClient["Type"]["observationQuery"]) {
	return makeCoreWrapper({ overrides: { observationQuery } }).wrapper;
}

describe("useObservations", () => {
	it("maps queried rows through the view layer", async () => {
		const wrapper = makeWrapper(() =>
			Effect.succeed({
				observations: [
					row({ id: "bw", schema_key: "bodyweight", values: { kg: 72.4 } }),
				],
			}),
		);

		const { result } = renderHook(() => useObservations(), {
			wrapper,
		});

		await waitFor(() => expect(result.current.data).toHaveLength(1));
		expect(result.current.data?.[0]?.summary).toContain("72.4 kg");
	});

	it("surfaces a Core-unreachable read as isError, NOT an empty list", async () => {
		// The load-bearing guarantee (mirrors useLibraryItems): a failed read must
		// reject so the view shows the distinct "Couldn't load" state, never []. A
		// regression that swallowed the rejection to [] would otherwise pass silently.
		const wrapper = makeWrapper(() =>
			Effect.fail(new WsRequestError({ reason: "connection_lost" })),
		);

		const { result } = renderHook(() => useObservations(), {
			wrapper,
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.data).toBeUndefined();
	});
});
