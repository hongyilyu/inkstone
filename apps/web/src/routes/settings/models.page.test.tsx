import { WsClient, type WsError } from "@inkstone/ui-sdk";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "@/routeTree.gen";
import { RuntimeProvider } from "@/runtime";
import { renderWithQuery } from "@/test-utils/renderWithQuery";

afterEach(cleanup);

const die = (): Effect.Effect<never, never> => Effect.die("unused");
const dieStream = (): Stream.Stream<never, WsError> =>
	Stream.fromEffect(Effect.die("unused")) as Stream.Stream<never, WsError>;

function makeRuntime(opts: { connected?: boolean; effort?: string }) {
	const settingsSet = vi.fn((params: { model?: string; effort?: string }) =>
		Effect.succeed({
			provider: "openai-codex",
			model: null,
			effort: params.effort ?? opts.effort ?? "off",
		}),
	);
	const stub = WsClient.of({
		threadCreate: die,
		postMessage: die,
		threadList: die,
		threadGet: die,
		subscribeRun: dieStream,
		providerStatus: () =>
			Effect.succeed({
				providers: [{ id: "openai-codex", connected: opts.connected ?? false }],
			}),
		providerLoginStart: () =>
			Effect.succeed({ authorize_url: "https://auth.example/x" }),
		modelCatalog: die,
		settingsGet: () =>
			Effect.succeed({
				provider: "openai-codex",
				model: null,
				effort: opts.effort ?? "off",
			}),
		settingsSet,
	});
	return {
		runtime: ManagedRuntime.make(Layer.succeed(WsClient, stub)),
		settingsSet,
	};
}

function renderPage(runtime: ReturnType<typeof makeRuntime>["runtime"]) {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: ["/settings/models"] }),
	});
	renderWithQuery(
		<RuntimeProvider runtime={runtime}>
			<RouterProvider router={router} />
		</RuntimeProvider>,
	);
}

describe("Models settings page (ADR-0024)", () => {
	it("reflects provider connection + global effort from the backend", async () => {
		const { runtime } = makeRuntime({ connected: true, effort: "high" });
		renderPage(runtime);

		await waitFor(() =>
			expect(screen.getByTestId("provider-status")).toHaveTextContent(
				/connected/i,
			),
		);
		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "High" })).toHaveAttribute(
				"aria-checked",
				"true",
			),
		);
	});

	it("persists an effort change via settings/set", async () => {
		const user = userEvent.setup();
		const { runtime, settingsSet } = makeRuntime({
			connected: false,
			effort: "off",
		});
		renderPage(runtime);

		// Effort loaded as "off".
		await waitFor(() =>
			expect(screen.getByRole("radio", { name: "Off" })).toHaveAttribute(
				"aria-checked",
				"true",
			),
		);

		await user.click(screen.getByRole("radio", { name: "Max" }));

		await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
		expect(settingsSet).toHaveBeenCalledWith({ effort: "xhigh" });
		// Optimistic update flips the active segment.
		expect(screen.getByRole("radio", { name: "Max" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});
});
