import type { ModelInfo } from "@inkstone/protocol";
import { WsClient, type WsError } from "@inkstone/ui-sdk";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
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

function makeRuntime(opts: {
	connected?: boolean;
	effort?: string;
	models?: readonly ModelInfo[];
}) {
	const settingsSet = vi.fn((params: { model?: string; effort?: string }) =>
		Effect.succeed({
			provider: "openai-codex",
			model: params.model ?? null,
			effort: params.effort ?? opts.effort ?? "off",
		}),
	);
	const stub = WsClient.of({
		threadCreate: die,
		postMessage: die,
		threadList: die,
		getRunHistory: die,
		threadGet: die,
		listEntities: die,
		entityMutate: die,
		subscribeRun: dieStream,
		cancelRun: die,
		providerStatus: () =>
			Effect.succeed({
				providers: [{ id: "openai-codex", connected: opts.connected ?? false }],
			}),
		providerLoginStart: () =>
			Effect.succeed({ authorize_url: "https://auth.example/x" }),
		modelCatalog: () =>
			Effect.succeed({
				providers: [
					{ id: "openai-codex", label: "OpenAI", models: opts.models ?? [] },
				],
			}),
		settingsGet: () =>
			Effect.succeed({
				provider: "openai-codex",
				model: null,
				effort: opts.effort ?? "off",
			}),
		settingsSet,
		proposalGet: die,
		proposalDecide: die,
		messageSearch: die,
		proposalNotifications: () => Stream.empty,
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

	it("lists the catalog and persists a preferred model via settings/set", async () => {
		const user = userEvent.setup();
		const models: ModelInfo[] = [
			{
				id: "gpt-5.5",
				name: "GPT-5.5",
				reasoning: true,
				input: ["text", "image"],
				cost_input: 5,
				cost_output: 30,
			},
			{
				id: "gpt-5.4-mini",
				name: "GPT-5.4 Mini",
				reasoning: true,
				input: ["text", "image"],
				cost_input: 0.75,
				cost_output: 4.5,
			},
		];
		const { runtime, settingsSet } = makeRuntime({ connected: true, models });
		renderPage(runtime);

		const row = await screen.findByRole("row", { name: /GPT-5\.5/ });
		expect(screen.getAllByRole("row")).toHaveLength(2);

		await user.click(
			within(row).getByRole("button", { name: /set as preferred/i }),
		);

		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({ model: "gpt-5.5" }),
		);
		expect(
			within(await screen.findByRole("row", { name: /GPT-5\.5/ })).getByText(
				/preferred/i,
			),
		).toBeInTheDocument();
	});

	it("ignores an out-of-order save: a stale response cannot overwrite the newer choice", async () => {
		const user = userEvent.setup();
		const models: ModelInfo[] = [
			{
				id: "gpt-5.5",
				name: "GPT-5.5",
				reasoning: true,
				input: ["text"],
				cost_input: 5,
				cost_output: 30,
			},
			{
				id: "gpt-5.4-mini",
				name: "GPT-5.4 Mini",
				reasoning: true,
				input: ["text"],
				cost_input: 0.75,
				cost_output: 4.5,
			},
		];
		// Gate each settings/set so the FIRST click's response resolves AFTER the
		// second's — the out-of-order interleave the version guard must absorb.
		const releases: Array<() => void> = [];
		const settingsSet = vi.fn((params: { model?: string; effort?: string }) =>
			Effect.promise(
				() => new Promise<void>((resolve) => releases.push(resolve)),
			).pipe(
				Effect.as({
					provider: "openai-codex",
					model: params.model ?? null,
					effort: params.effort ?? "off",
				}),
			),
		);
		const stub = WsClient.of({
			threadCreate: die,
			postMessage: die,
			threadList: die,
			getRunHistory: die,
			threadGet: die,
			listEntities: die,
			entityMutate: die,
			subscribeRun: dieStream,
			cancelRun: die,
			providerStatus: () =>
				Effect.succeed({
					providers: [{ id: "openai-codex", connected: true }],
				}),
			providerLoginStart: die,
			modelCatalog: () =>
				Effect.succeed({
					providers: [{ id: "openai-codex", label: "OpenAI", models }],
				}),
			settingsGet: () =>
				Effect.succeed({
					provider: "openai-codex",
					model: null,
					effort: "off",
				}),
			settingsSet,
			proposalGet: die,
			proposalDecide: die,
			messageSearch: die,
			proposalNotifications: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		renderPage(runtime);

		const row55 = await screen.findByRole("row", { name: /GPT-5\.5/ });
		const rowMini = await screen.findByRole("row", { name: /GPT-5\.4 Mini/ });

		// Click 5.5 (first), then Mini (second, the user's latest intent).
		await user.click(
			within(row55).getByRole("button", { name: /set as preferred/i }),
		);
		await user.click(
			within(rowMini).getByRole("button", { name: /set as preferred/i }),
		);
		await waitFor(() => expect(releases).toHaveLength(2));

		// Resolve OUT OF ORDER: the stale first (5.5) lands AFTER the newer (Mini).
		releases[1]();
		releases[0]();

		// The UI must reflect the newer choice (Mini), not the stale first response.
		// Match the "Preferred" badge exactly — NOT the "Set as preferred" button
		// label (which also contains "preferred").
		await waitFor(() =>
			expect(
				within(screen.getByRole("row", { name: /GPT-5\.4 Mini/ })).getByText(
					"Preferred",
				),
			).toBeInTheDocument(),
		);
		expect(
			within(screen.getByRole("row", { name: /GPT-5\.5/ })).queryByText(
				"Preferred",
			),
		).toBeNull();
		// The stale row instead offers "Set as preferred" again (not selected).
		expect(
			within(screen.getByRole("row", { name: /GPT-5\.5/ })).getByRole(
				"button",
				{
					name: /set as preferred/i,
				},
			),
		).toBeInTheDocument();

		await runtime.dispose();
	});
});
