import "@testing-library/jest-dom/vitest";

// jsdom does not implement ResizeObserver — App's clip-path measurement uses it.
if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = class ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}
