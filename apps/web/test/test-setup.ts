import "@testing-library/jest-dom/vitest";

// jsdom does not implement scrollTo, but TanStack Router calls it during route
// commits in component tests.
if ("window" in globalThis) {
	Object.defineProperty(window, "scrollTo", {
		value: () => {},
		writable: true,
	});
}

// jsdom does not implement ResizeObserver — App's clip-path measurement uses it.
if (!("ResizeObserver" in globalThis)) {
	globalThis.ResizeObserver = class ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}
