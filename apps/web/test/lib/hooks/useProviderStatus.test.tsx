import type { ProviderStatusResult } from "@inkstone/protocol";
import { stubWsClient, WsClient } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useProviderStatus } from "@/lib/hooks/useProviderStatus.js";
import { RuntimeProvider } from "@/runtime";

// A WsClient stub whose `providerStatus` returns `result` and counts calls; the
// rest die. The counter lets the remount test prove the read is not permanently
// stale (it refetches on every mount).
function makeRuntime(
	result: ProviderStatusResult,
	counter?: { calls: number },
) {
	const stub = stubWsClient({
		providerStatus: () =>
			Effect.sync(() => {
				if (counter) counter.calls += 1;
				return result;
			}),
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

function wrapper(runtime: ReturnType<typeof makeRuntime>, client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
		</QueryClientProvider>
	);
}

describe("useProviderStatus", () => {
	it("anyConnected is false when every provider is disconnected", async () => {
		const runtime = makeRuntime({
			providers: [{ id: "openai-codex", connected: false, auth_kind: "oauth" }],
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(() => useProviderStatus(), {
			wrapper: wrapper(runtime, client),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.anyConnected).toBe(false);
	});

	it("anyConnected is true when at least one provider is connected", async () => {
		const runtime = makeRuntime({
			providers: [{ id: "openai-codex", connected: true, auth_kind: "oauth" }],
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(() => useProviderStatus(), {
			wrapper: wrapper(runtime, client),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.anyConnected).toBe(true);
	});

	it("anyConnected is false for an empty provider list", async () => {
		const runtime = makeRuntime({ providers: [] });
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(() => useProviderStatus(), {
			wrapper: wrapper(runtime, client),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.anyConnected).toBe(false);
	});

	it("refetches on remount (not served from a permanently-stale cache)", async () => {
		// The gate-lifts-after-connect mechanism depends on this: returning from
		// /settings remounts the chat column, which must re-read provider status
		// rather than serve the Infinity-stale global cache.
		const counter = { calls: 0 };
		const runtime = makeRuntime(
			{
				providers: [
					{ id: "openai-codex", connected: false, auth_kind: "oauth" },
				],
			},
			counter,
		);
		// Replicate the production QueryClient's `staleTime: Infinity` (main.tsx) so
		// the remount refetch can ONLY come from the hook's own staleTime:0/
		// refetchOnMount override — not a permissive client default. Without this the
		// test would pass even if the override were deleted (it would refetch via the
		// client), so it would not be load-bearing.
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			},
		});

		const first = renderHook(() => useProviderStatus(), {
			wrapper: wrapper(runtime, client),
		});
		await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
		expect(counter.calls).toBe(1);
		first.unmount();

		const second = renderHook(() => useProviderStatus(), {
			wrapper: wrapper(runtime, client),
		});
		await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
		await waitFor(() => expect(counter.calls).toBeGreaterThan(1));
	});
});
