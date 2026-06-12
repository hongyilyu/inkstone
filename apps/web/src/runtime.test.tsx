import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveWsUrl, RuntimeProvider, useRuntime } from "./runtime.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("deriveWsUrl", () => {
	it("derives a same-origin ws:// URL from an http location", () => {
		// WS URL derives from window.location host, not a hardcoded port (ADR-0019).
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
		// Lazy ManagedRuntime: building + providing it runs no WsClientLive layer, so a passive child opens zero sockets.
		const wsSpy = vi.fn();
		vi.stubGlobal("WebSocket", wsSpy);

		render(
			<RuntimeProvider config={{ url: "ws://stub/ws" }}>
				<div data-testid="passive">no effect run here</div>
			</RuntimeProvider>,
		);

		expect(screen.getByTestId("passive")).toBeInTheDocument();
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

		// Suppress React's error-boundary logging for the expected render throw.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => render(<OrphanProbe />)).toThrow(
			/useRuntime must be used within a RuntimeProvider/,
		);
		errorSpy.mockRestore();
	});
});
