import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import App from "../App.js";

// Node 26's experimental localStorage is gated by --localstorage-file, leaving
// jsdom's window.localStorage undefined. Provide an in-memory polyfill so the
// theme-persistence assertions can run.
function installLocalStorage() {
	const store = new Map<string, string>();
	const ls: Storage = {
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		getItem: (k) => (store.has(k) ? (store.get(k) ?? null) : null),
		setItem: (k, v) => void store.set(k, String(v)),
		removeItem: (k) => void store.delete(k),
		key: (i) => Array.from(store.keys())[i] ?? null,
	};
	Object.defineProperty(window, "localStorage", {
		value: ls,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, "localStorage", {
		value: ls,
		configurable: true,
		writable: true,
	});
}

describe("TopRightControls", () => {
	beforeEach(() => {
		installLocalStorage();
		document.documentElement.dataset.theme = "light";
		localStorage.clear();
	});
	afterEach(() => {
		cleanup();
		delete document.documentElement.dataset.theme;
		localStorage.clear();
	});

	it("theme toggle flips data-theme + localStorage", async () => {
		const user = userEvent.setup();
		renderWithQuery(<App />);
		const toggle = screen.getByRole("button", { name: /toggle theme/i });

		await user.click(toggle);
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(localStorage.getItem("inkstone-theme")).toBe("dark");

		await user.click(toggle);
		expect(document.documentElement.dataset.theme).toBe("light");
		expect(localStorage.getItem("inkstone-theme")).toBe("light");
	});
});
