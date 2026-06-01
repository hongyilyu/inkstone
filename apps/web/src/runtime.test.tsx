import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import App from "./App.js";
import { RuntimeProvider, useRuntime } from "./runtime.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("RuntimeProvider", () => {
	it("mounts the shell under the provider without opening a socket", () => {
		// Spy on the WebSocket constructor BEFORE rendering. A lazy
		// ManagedRuntime must not run the WsClientLive layer at mount, so
		// zero sockets should be constructed.
		const wsSpy = vi.fn();
		vi.stubGlobal("WebSocket", wsSpy);

		renderWithQuery(
			<RuntimeProvider config={{ url: "ws://stub/ws" }}>
				<App />
			</RuntimeProvider>,
		);

		// The shell renders even with Core down (no real server).
		expect(screen.getByRole("main")).toBeInTheDocument();
		// Lazy runtime: no socket opened at mount.
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
