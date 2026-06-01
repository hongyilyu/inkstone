import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
	appendUserMessage,
	resetChatStore,
	setFocusedThread,
	useThreadMessages,
} from "./chat.js";

// Regression guard for the Zustand migration (slice A): the selector hooks must
// keep returning a STABLE array reference across unrelated state changes. This
// is the property that lets `ChatColumn` bail out of re-rendering when an
// unrelated thread changes, and the property `useSyncExternalStore` / Zustand's
// `useStore` rely on (Object.is identity on the selector result). A selector
// that minted a fresh array on every read would fail these assertions — and
// under Zustand v5 would also trip the "getSnapshot should be cached" guard.
//
// Written against the PUBLIC interface only (no internal imports).

beforeEach(() => {
	resetChatStore();
});

describe("chat selectors — reference stability", () => {
	it("keeps a stable messages reference across an unrelated focus change", () => {
		// Seed threadA so it is a non-empty thread with a real array.
		act(() => {
			appendUserMessage("threadA", {
				id: "m1",
				role: "user",
				status: "completed",
				text: "hi",
				run_id: "",
			});
		});

		const { result, rerender } = renderHook(() =>
			useThreadMessages("threadA"),
		);
		const first = result.current;
		expect(first.map((m) => m.text)).toEqual(["hi"]);

		// Unrelated state change: focus a DIFFERENT thread. threadA's messages
		// array must not be re-created → the selector returns the same reference.
		act(() => {
			setFocusedThread("threadB");
		});
		rerender();

		expect(result.current).toBe(first);
	});

	it("keeps a stable messages reference when a DIFFERENT thread mutates", () => {
		act(() => {
			appendUserMessage("threadA", {
				id: "m1",
				role: "user",
				status: "completed",
				text: "hi",
				run_id: "",
			});
		});

		const { result, rerender } = renderHook(() =>
			useThreadMessages("threadA"),
		);
		const first = result.current;

		// Append to an UNRELATED thread; threadA's slice is untouched.
		act(() => {
			appendUserMessage("threadB", {
				id: "m2",
				role: "user",
				status: "completed",
				text: "other",
				run_id: "",
			});
		});
		rerender();

		expect(result.current).toBe(first);
	});

	it("returns a stable empty reference for an empty thread across unrelated changes", () => {
		const { result, rerender } = renderHook(() =>
			useThreadMessages("ghost"),
		);
		const first = result.current;
		expect(first).toEqual([]);

		// Mutate an unrelated thread; the empty thread's selector must keep
		// returning the same stable empty-array reference (no fresh `[]` minted).
		act(() => {
			appendUserMessage("other", {
				id: "m1",
				role: "user",
				status: "completed",
				text: "x",
				run_id: "",
			});
		});
		rerender();
		expect(result.current).toBe(first);

		// Another unrelated change — still the same empty reference.
		act(() => {
			setFocusedThread("another");
		});
		rerender();
		expect(result.current).toBe(first);
	});
});
