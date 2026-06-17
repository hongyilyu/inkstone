import type { RunHistoryItem } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { useRuntime } from "@/runtime";

/** The recent-Runs feed: live `run/get_history` rows from Core (ADR-0028
 * as-built), newest-first. Reads via TanStack Query under the `["run-history"]`
 * key (reads path per ADR-0020); the query's own `isPending`/`isError` drive the
 * feed's loading/error states, so — unlike `useLibraryItems` — a Core-unreachable
 * read surfaces as `isError` rather than being swallowed to an empty list. */
export function useRunHistory() {
	const runtime = useRuntime();
	return useQuery<readonly RunHistoryItem[]>({
		queryKey: ["run-history"],
		queryFn: () =>
			runtime.runPromise(
				Effect.gen(function* () {
					const client = yield* WsClient;
					const { runs } = yield* client.getRunHistory();
					return runs;
				}),
			),
	});
}
