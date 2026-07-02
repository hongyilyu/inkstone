import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useOptimisticSetting } from "@/lib/hooks/useOptimisticSetting";

/** A persist fn whose each call is resolved/rejected by the caller, in any order. */
function gatedPersist<T>() {
	const calls: Array<{
		value: T;
		resolve: (v: T) => void;
		reject: () => void;
	}> = [];
	const persist = (value: T) =>
		new Promise<T>((resolve, reject) => {
			calls.push({ value, resolve, reject });
		});
	return { persist, calls };
}

describe("useOptimisticSetting", () => {
	it("optimistically reflects the new value and confirms on success", async () => {
		const { persist, calls } = gatedPersist<string>();
		const { result } = renderHook(() => useOptimisticSetting("off", persist));

		act(() => result.current.set("high"));
		expect(result.current.value).toBe("high"); // optimistic, before the network

		act(() => calls[0].resolve("high"));
		await waitFor(() => expect(result.current.status).toBe("saved"));
		expect(result.current.value).toBe("high");
	});

	it("ignores an out-of-order response (latest-write-wins)", async () => {
		const { persist, calls } = gatedPersist<string>();
		const { result } = renderHook(() => useOptimisticSetting("off", persist));

		act(() => result.current.set("a")); // call 0
		act(() => result.current.set("b")); // call 1 (newest)
		expect(result.current.value).toBe("b");

		// The OLDER call resolves last — it must NOT overwrite the newer choice.
		act(() => calls[1].resolve("b"));
		act(() => calls[0].resolve("a"));
		await waitFor(() => expect(result.current.status).toBe("saved"));
		expect(result.current.value).toBe("b");
	});

	it("rolls a failure back to the last CONFIRMED-persisted value, not the optimistic one", async () => {
		const { persist, calls } = gatedPersist<string>();
		// Seeded persisted value is "low".
		const { result } = renderHook(() => useOptimisticSetting("low", persist));

		act(() => result.current.set("max")); // call 0 (optimistic max)
		act(() => result.current.set("high")); // call 1 (optimistic high, newest)
		expect(result.current.value).toBe("high");

		// Newest fails: roll back to persisted "low" — NOT the pre-click "max".
		act(() => calls[1].reject());
		await waitFor(() => expect(result.current.value).toBe("low"));
		expect(result.current.status).toBe("error");

		// The older call then fails too — still "low", no flicker to a stale value.
		act(() => calls[0].reject());
		await waitFor(() => expect(result.current.value).toBe("low"));
	});

	it("advances the rollback snapshot only on a confirmed success", async () => {
		const { persist, calls } = gatedPersist<string>();
		const { result } = renderHook(() => useOptimisticSetting("off", persist));

		// Confirm a save → snapshot becomes "high".
		act(() => result.current.set("high"));
		act(() => calls[0].resolve("high"));
		await waitFor(() => expect(result.current.status).toBe("saved"));

		// A later failed save rolls back to the newly-confirmed "high".
		act(() => result.current.set("max"));
		act(() => calls[1].reject());
		await waitFor(() => expect(result.current.value).toBe("high"));
	});

	it("seed syncs value + rollback target without marking a save", async () => {
		const { persist, calls } = gatedPersist<string>();
		const { result } = renderHook(() => useOptimisticSetting("off", persist));

		act(() => result.current.seed("medium"));
		expect(result.current.value).toBe("medium");
		expect(result.current.status).toBe("idle"); // seed is not a user write

		// A failed save after seed rolls back to the seeded value.
		act(() => result.current.set("max"));
		act(() => calls[0].reject());
		await waitFor(() => expect(result.current.value).toBe("medium"));
	});
});
