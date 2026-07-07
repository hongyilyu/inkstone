import type { ProviderStatusResult } from "@inkstone/protocol";
import { makeCoreWrapper } from "@test/test-utils/renderWithCore";
import { renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { useProviderStatus } from "@/lib/hooks/useProviderStatus.js";

// A WsClient stub whose `providerStatus` returns `result` and counts calls; the
// rest die. The counter lets the remount test prove the read is not permanently
// stale (it refetches on every mount).
function makeWrapper(
	result: ProviderStatusResult,
	counter?: { calls: number },
) {
	return makeCoreWrapper({
		overrides: {
			providerStatus: () =>
				Effect.sync(() => {
					if (counter) counter.calls += 1;
					return result;
				}),
		},
	}).wrapper;
}

describe("useProviderStatus", () => {
	it("anyConnected is false when every provider is disconnected", async () => {
		const wrapper = makeWrapper({
			providers: [{ id: "openai-codex", connected: false, auth_kind: "oauth" }],
		});

		const { result } = renderHook(() => useProviderStatus(), {
			wrapper,
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.anyConnected).toBe(false);
	});

	it("anyConnected is true when at least one provider is connected", async () => {
		const wrapper = makeWrapper({
			providers: [{ id: "openai-codex", connected: true, auth_kind: "oauth" }],
		});

		const { result } = renderHook(() => useProviderStatus(), {
			wrapper,
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.anyConnected).toBe(true);
	});

	it("anyConnected is false for an empty provider list", async () => {
		const wrapper = makeWrapper({ providers: [] });

		const { result } = renderHook(() => useProviderStatus(), {
			wrapper,
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.anyConnected).toBe(false);
	});

	it("refetches on remount (not served from a permanently-stale cache)", async () => {
		// The gate-lifts-after-connect mechanism depends on this: returning from
		// /settings remounts the chat column, which must re-read provider status
		// rather than serve the Infinity-stale global cache.
		const counter = { calls: 0 };
		// The harness client replicates the production QueryClient's
		// `staleTime: Infinity` (main.tsx), so the remount refetch can ONLY come
		// from the hook's own staleTime:0/refetchOnMount override — not a
		// permissive client default. Without this the test would pass even if the
		// override were deleted (it would refetch via the client), so it would not
		// be load-bearing. Both renders share ONE wrapper (one client + runtime).
		const wrapper = makeWrapper(
			{
				providers: [
					{ id: "openai-codex", connected: false, auth_kind: "oauth" },
				],
			},
			counter,
		);

		const first = renderHook(() => useProviderStatus(), {
			wrapper,
		});
		await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
		expect(counter.calls).toBe(1);
		first.unmount();

		const second = renderHook(() => useProviderStatus(), {
			wrapper,
		});
		await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
		await waitFor(() => expect(counter.calls).toBeGreaterThan(1));
	});
});
