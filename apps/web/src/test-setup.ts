import "@testing-library/jest-dom/vitest";

// jsdom does not implement scrollTo, but TanStack Router calls it during route
// commits in component tests.
if (typeof window !== "undefined") {
	Object.defineProperty(window, "scrollTo", {
		value: () => {},
		writable: true,
	});
}

// jsdom does not implement ResizeObserver — App's clip-path measurement uses it.
if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = class ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}
