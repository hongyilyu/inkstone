import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { useRuntime } from "@/runtime";

/** `message/search` read via TanStack Query (reads path per ADR-0020), keyed `["message-search", query]`; the fetch is enabled only for a non-empty trimmed query, so an empty palette makes no server call. */
export function useMessageSearch(query: string) {
	const runtime = useRuntime();
	const trimmed = query.trim();
	return useQuery({
		queryKey: ["message-search", trimmed],
		enabled: trimmed.length > 0,
		queryFn: () =>
			runtime.runPromise(
				Effect.gen(function* () {
					const client = yield* WsClient;
					return yield* client.messageSearch(trimmed);
				}),
			),
	});
}
