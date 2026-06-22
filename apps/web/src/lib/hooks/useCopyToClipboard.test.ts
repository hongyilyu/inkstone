import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCopyToClipboard } from "./useCopyToClipboard";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("useCopyToClipboard", () => {
	it("flags `copied` on a successful write, not `failed`", async () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		const { result } = renderHook(() => useCopyToClipboard());

		await act(async () => {
			await result.current.copy("hello");
		});

		expect(writeText).toHaveBeenCalledWith("hello");
		expect(result.current.copied).toBe(true);
		expect(result.current.failed).toBe(false);
	});

	it("flags `failed` (never a fake success) when the write rejects", async () => {
		const writeText = vi.fn(() => Promise.reject(new Error("denied")));
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		const { result } = renderHook(() => useCopyToClipboard());

		await act(async () => {
			await result.current.copy("hello");
		});

		// The rejection is caught, NOT thrown into a floating promise, and surfaces
		// as `failed` so the UI can show an honest "Couldn't copy" — never a checkmark.
		expect(result.current.failed).toBe(true);
		expect(result.current.copied).toBe(false);
	});

	it("flags `failed` when the clipboard API is unavailable (no write attempted)", async () => {
		Object.defineProperty(navigator, "clipboard", {
			value: undefined,
			configurable: true,
		});
		const { result } = renderHook(() => useCopyToClipboard());

		await act(async () => {
			await result.current.copy("hello");
		});

		expect(result.current.failed).toBe(true);
		expect(result.current.copied).toBe(false);
	});

	it("clears the flag after the reset window", async () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		const { result } = renderHook(() => useCopyToClipboard(50));

		await act(async () => {
			await result.current.copy("hello");
		});
		expect(result.current.copied).toBe(true);

		// Real timers (the awaited copy promise + fake timers deadlock); a short
		// reset window keeps the wait cheap.
		await waitFor(() => expect(result.current.copied).toBe(false));
	});
});
