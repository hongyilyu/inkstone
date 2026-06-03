import { WsClient, type WsError, type RunId } from "@inkstone/ui-sdk";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeProvider } from "../runtime.js";
import { SettingsPanel } from "./SettingsPanel.js";

afterEach(() => {
	cleanup();
});

const unusedStream = (): Stream.Stream<never, WsError> =>
	Stream.fromEffect(Effect.die("not exercised")) as Stream.Stream<never, WsError>;

/**
 * A stub WsClient whose `providerStatus.connected` flips after
 * `providerLoginStart` is called — modelling Core persisting credentials
 * after the (separate-tab) login completes. `providerLoginStart` returns a
 * canned authorize URL and records that it was called.
 */
function makeRuntime(opts: { authorizeUrl: string }) {
	let connected = false;
	const loginStart = vi.fn(() => {
		// The real flow flips connected out-of-band after the browser
		// callback; the test simulates that by flipping on login_start so the
		// subsequent focus-driven status re-query observes it.
		connected = true;
		return Effect.succeed({ authorize_url: opts.authorizeUrl });
	});
	const status = vi.fn(() =>
		Effect.succeed({
			providers: [{ id: "openai-codex", connected }],
		}),
	);
	const stub = WsClient.of({
		threadCreate: () => Effect.die("unused"),
		postMessage: () => Effect.die("unused") as Effect.Effect<RunId, WsError>,
		threadList: () => Effect.die("unused"),
		threadGet: () => Effect.die("unused"),
		subscribeRun: () => unusedStream(),
		providerStatus: status,
		providerLoginStart: loginStart,
	});
	const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
	return { runtime, loginStart, status };
}

describe("SettingsPanel — Connect ChatGPT", () => {
	it("shows disconnected, then Connect opens the authorize URL in a new tab", async () => {
		const user = userEvent.setup();
		const authorizeUrl = "https://auth.openai.com/oauth/authorize?x=1";
		const { runtime, loginStart } = makeRuntime({ authorizeUrl });
		const openUrl = vi.fn();

		render(
			<RuntimeProvider runtime={runtime}>
				<SettingsPanel openUrl={openUrl} />
			</RuntimeProvider>,
		);

		// Initial status query resolves to disconnected.
		await waitFor(() =>
			expect(screen.getByTestId("chatgpt-status")).toHaveTextContent(
				"Disconnected",
			),
		);

		// Click Connect → login_start invoked, authorize URL opened in a tab.
		await user.click(screen.getByRole("button", { name: "Connect" }));
		await waitFor(() => expect(loginStart).toHaveBeenCalledTimes(1));
		expect(openUrl).toHaveBeenCalledWith(authorizeUrl);

		await runtime.dispose();
	});

	it("re-queries status on window focus and flips to Connected", async () => {
		const user = userEvent.setup();
		const { runtime, status } = makeRuntime({
			authorizeUrl: "https://auth.openai.com/oauth/authorize?x=1",
		});
		const openUrl = vi.fn();

		render(
			<RuntimeProvider runtime={runtime}>
				<SettingsPanel openUrl={openUrl} />
			</RuntimeProvider>,
		);

		await waitFor(() =>
			expect(screen.getByTestId("chatgpt-status")).toHaveTextContent(
				"Disconnected",
			),
		);

		// Begin login (flips the stub's connected flag), then simulate the
		// user returning to this tab — the focus listener re-queries status.
		await user.click(screen.getByRole("button", { name: "Connect" }));
		const callsBeforeFocus = status.mock.calls.length;
		fireEvent.focus(window);

		await waitFor(() =>
			expect(screen.getByTestId("chatgpt-status")).toHaveTextContent(
				"Connected",
			),
		);
		expect(status.mock.calls.length).toBeGreaterThan(callsBeforeFocus);

		await runtime.dispose();
	});
});
