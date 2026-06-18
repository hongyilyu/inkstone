import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
	appendUserMessage,
	focusMessage,
	resetChatStore,
	useThreadMessages,
} from "./chat.js";

// Selector hooks must return a STABLE array reference across unrelated state
// changes (Object.is identity) — see docs/design/web-store-tests.md

beforeEach(() => {
	resetChatStore();
});

describe("chat selectors — reference stability", () => {
	it("keeps a stable messages reference across an unrelated focus change", () => {
		act(() => {
			appendUserMessage("threadA", {
				id: "m1",
				role: "user",
				status: "completed",
				text: "hi",
				run_id: "",
			});
		});

		const { result, rerender } = renderHook(() => useThreadMessages("threadA"));
		const first = result.current;
		expect(first.map((m) => m.text)).toEqual(["hi"]);

		// Unrelated change: setting the message anchor must not re-create threadA's array.
		act(() => {
			focusMessage("m1");
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

		const { result, rerender } = renderHook(() => useThreadMessages("threadA"));
		const first = result.current;

		// Append to an unrelated thread; threadA's slice is untouched.
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
		const { result, rerender } = renderHook(() => useThreadMessages("ghost"));
		const first = result.current;
		expect(first).toEqual([]);

		// Mutate an unrelated thread; the empty selector must keep its stable [] reference.
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

		act(() => {
			focusMessage("m1");
		});
		rerender();
		expect(result.current).toBe(first);
	});
});
