import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveWsUrl, RuntimeProvider, useRuntime } from "./runtime.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("deriveWsUrl", () => {
	it("derives a same-origin ws:// URL from an http location", () => {
		// A Core-served SPA must dial the Core that served it, on whatever
		// (possibly ephemeral) port that is — so the WS URL is derived from
		// window.location's host, not a hardcoded port (ADR-0019 harness).
		expect(deriveWsUrl({ protocol: "http:", host: "127.0.0.1:4321" })).toBe(
			"ws://127.0.0.1:4321/ws",
		);
	});

	it("upgrades to wss:// when the page is served over https", () => {
		expect(deriveWsUrl({ protocol: "https:", host: "app.example:8443" })).toBe(
			"wss://app.example:8443/ws",
		);
	});
});

describe("RuntimeProvider", () => {
	it("provides the runtime without opening a socket until an effect runs", () => {
		// Spy on the WebSocket constructor BEFORE rendering. A lazy
		// ManagedRuntime must not run the WsClientLive layer when it is merely
		// built + provided, so a passive subtree that never runs an SDK effect
		// constructs zero sockets. (App itself now reads thread/list on mount —
		// that intentionally opens a socket; the laziness guarantee is about the
		// runtime, proven here against a passive child.)
		const wsSpy = vi.fn();
		vi.stubGlobal("WebSocket", wsSpy);

		render(
			<RuntimeProvider config={{ url: "ws://stub/ws" }}>
				<div data-testid="passive">no effect run here</div>
			</RuntimeProvider>,
		);

		expect(screen.getByTestId("passive")).toBeInTheDocument();
		// Lazy runtime: providing it ran no effect, so no socket opened.
		expect(wsSpy).toHaveBeenCalledTimes(0);
	});

	it("exposes the runtime via useRuntime inside the provider", () => {
		function Probe() {
			const runtime = useRuntime();
			return <div data-testid="probe">{typeof runtime.runFork}</div>;
		}

		render(
			<RuntimeProvider config={{ url: "ws://stub/ws" }}>
				<Probe />
			</RuntimeProvider>,
		);

		const probe = screen.getByTestId("probe");
		expect(probe).toBeInTheDocument();
		expect(probe.textContent).toBe("function");
	});

	it("throws when useRuntime is used outside the provider", () => {
		function OrphanProbe() {
			useRuntime();
			return null;
		}

		// React surfaces the throw from the render; suppress the noisy
		// error-boundary logging React emits for the expected throw.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => render(<OrphanProbe />)).toThrow(
			/useRuntime must be used within a RuntimeProvider/,
		);
		errorSpy.mockRestore();
	});
});
