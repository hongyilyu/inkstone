import type { ObservationRow } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import {
	type ObservationItemView,
	toObservationView,
} from "@/lib/observationView";
import { useRuntime } from "@/runtime";

/** Map the live `observation/query` rows into display-ready view items. Each row
 * goes through `toObservationView`, which is schema-aware where we know the schema
 * and degrades to a raw-JSON fallback otherwise (it never throws). Pure — unit
 * tested directly in `useObservations.test.ts`; the hook below only supplies the
 * rows. */
export function assembleObservationItems(
	rows: readonly ObservationRow[],
): ObservationItemView[] {
	return rows.map(toObservationView);
}

/** The recorded observations from Core (ADR-0053). A Core-unreachable read REJECTS
 * (surfacing as the query's `isError`) rather than being swallowed to `[]`: an
 * empty list and a failed read are different states, same rationale as
 * `useLibraryItems`. */
export function useObservations() {
	const runtime = useRuntime();
	return useQuery({
		queryKey: ["observations"],
		queryFn: async () => {
			const program = Effect.gen(function* () {
				const client = yield* WsClient;
				const result = yield* client.observationQuery({});
				return result.observations;
			});
			// Let a Core-unreachable read reject — the query surfaces it as `isError`
			// (a distinct "Couldn't load" state), not a misleading empty list.
			const rows = await runtime.runPromise(program);
			return assembleObservationItems(rows);
		},
	});
}
