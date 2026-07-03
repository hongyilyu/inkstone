import { stubWsClient, WsClient } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithQuery } from "@test/test-utils/renderWithQuery";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ModelPicker } from "@/components/ModelPicker.js";
import { RuntimeProvider } from "@/runtime";

afterEach(cleanup);

const CATALOG = {
	providers: [
		{
			id: "openai-codex",
			label: "OpenAI",
			models: [
				{
					id: "gpt-5.5",
					name: "GPT-5.5",
					reasoning: true,
					input: ["text", "image"],
				},
				{
					id: "gpt-5.4-mini",
					name: "GPT-5.4 Mini",
					reasoning: false,
					input: ["text"],
				},
			],
		},
		{
			id: "openrouter",
			label: "OpenRouter",
			models: [
				{
					id: "anthropic/claude-opus-4.8",
					name: "Claude Opus 4.8",
					reasoning: true,
					input: ["text", "image"],
				},
			],
		},
	],
} as const;

/** A stub runtime whose catalog has two models; settings decide which are enabled.
 * `providers` sets each provider's connected flag (ADR-0062); default is
 * codex-connected + openrouter-disconnected. */
function makeRuntime(
	enabledModels: readonly string[],
	{
		settingsPending = false,
		statusPending = false,
		providers = [
			{ id: "openai-codex", connected: true, auth_kind: "oauth" as const },
			{ id: "openrouter", connected: false, auth_kind: "api_key" as const },
		],
	}: {
		settingsPending?: boolean;
		// When true, provider/status never resolves — models the async gap where the
		// catalog + settings loaded but connectivity is still unknown.
		statusPending?: boolean;
		providers?: readonly {
			id: string;
			connected: boolean;
			auth_kind: "oauth" | "api_key";
		}[];
	} = {},
) {
	const settingsResult = {
		provider: "openai-codex",
		model: "gpt-5.5",
		effort: "off",
		enabled_models: enabledModels,
	};
	const stub = stubWsClient({
		providerStatus: () =>
			statusPending ? Effect.never : Effect.succeed({ providers }),
		modelCatalog: () => Effect.succeed(CATALOG),
		// When `settingsPending`, settings/get never resolves — modelling the
		// async gap where the catalog has loaded but settings have not.
		settingsGet: () =>
			settingsPending ? Effect.never : Effect.succeed(settingsResult),
		settingsSet: () => Effect.succeed(settingsResult),
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

describe("ModelPicker", () => {
	it("lists only models in enabled_models when it is a strict subset", async () => {
		const user = userEvent.setup();
		const runtime = makeRuntime(["gpt-5.5"]);
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ModelPicker />
			</RuntimeProvider>,
		);

		await user.click(screen.getByRole("button", { name: /select model/i }));

		// The popup list offers the enabled model…
		const list = await screen.findByRole("list");
		expect(within(list).getByText("GPT-5.5")).toBeInTheDocument();
		// …and the model absent from enabled_models is NOT a choice.
		expect(within(list).queryByText("GPT-5.4 Mini")).toBeNull();

		await runtime.dispose();
	});

	it("shows ALL catalog models when enabled_models is empty (no curation)", async () => {
		const user = userEvent.setup();
		const runtime = makeRuntime([]);
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ModelPicker />
			</RuntimeProvider>,
		);

		await user.click(screen.getByRole("button", { name: /select model/i }));

		// `[]` means "no restriction → full catalog", not "show none".
		const list = await screen.findByRole("list");
		expect(within(list).getByText("GPT-5.5")).toBeInTheDocument();
		expect(within(list).getByText("GPT-5.4 Mini")).toBeInTheDocument();

		await runtime.dispose();
	});

	it("tags each row with its provider so a same-named model from two providers is distinguishable", async () => {
		const user = userEvent.setup();
		// Both providers connected; enabled set empty (show all). The codex GPT-5.5
		// and (hypothetically) an openrouter model share the picker — every row must
		// carry its provider label so the two are told apart (opencode-style).
		const runtime = makeRuntime([], {
			providers: [
				{ id: "openai-codex", connected: true, auth_kind: "oauth" as const },
				{ id: "openrouter", connected: true, auth_kind: "api_key" as const },
			],
		});
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ModelPicker />
			</RuntimeProvider>,
		);

		await user.click(screen.getByRole("button", { name: /select model/i }));
		const list = await screen.findByRole("list");

		// The codex model's row is tagged (OpenAI); the openrouter model's, (OpenRouter).
		const codexRow = within(list).getByText("GPT-5.5").closest("button");
		expect(codexRow).toHaveTextContent("(OpenAI)");
		const orRow = within(list).getByText("Claude Opus 4.8").closest("button");
		expect(orRow).toHaveTextContent("(OpenRouter)");

		await runtime.dispose();
	});

	it("HIDES a model whose provider is not connected — only connected-provider models are listed (ADR-0062)", async () => {
		const user = userEvent.setup();
		// Both models enabled, but openrouter is NOT connected: its model must not be
		// OFFERED at all (a run against it would be tokenless — Core now rejects it),
		// while the connected codex model is the only listed choice.
		const runtime = makeRuntime(["gpt-5.5", "anthropic/claude-opus-4.8"]);
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ModelPicker />
			</RuntimeProvider>,
		);

		await user.click(screen.getByRole("button", { name: /select model/i }));
		const list = await screen.findByRole("list");

		// The connected provider's model is a real, selectable choice.
		const codexRow = within(list).getByText("GPT-5.5").closest("button");
		expect(codexRow).not.toBeNull();
		expect(codexRow).not.toBeDisabled();

		// The disconnected provider's model is NOT shown at all — no locked row.
		expect(within(list).queryByText("Claude Opus 4.8")).toBeNull();

		await runtime.dispose();
	});

	it("shows NO model while provider/status is unresolved (no fail-open — connectivity unknown means hide)", async () => {
		const user = userEvent.setup();
		// Catalog + settings resolve, but provider/status never does: connectivity is
		// unknown. A known-provider model must NOT be offered in this gap — showing an
		// unusable model would dead-end the send. gpt-5.5 belongs to a KNOWN provider
		// group (openai-codex), so it is hidden until status confirms connectivity.
		const runtime = makeRuntime(["gpt-5.5"], { statusPending: true });
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ModelPicker />
			</RuntimeProvider>,
		);

		await user.click(screen.getByRole("button", { name: /select model/i }));
		const list = await screen.findByRole("list");

		// The model is NOT listed while status is unresolved — the empty-state copy
		// shows instead.
		expect(within(list).queryByText("GPT-5.5")).toBeNull();
		expect(within(list).getByText(/no models available/i)).toBeInTheDocument();

		await runtime.dispose();
	});

	it("drops a persisted selection whose provider disconnects — asserts the PRESENT→ABSENT transition, not just the end state (ADR-0062)", async () => {
		// The stored default is gpt-5.5 (codex). provider/status resolves CONNECTED
		// first (so the trigger shows "GPT-5.5"), then a refetch reports codex
		// DISCONNECTED. The picker must then clear the stale selection. Asserting the
		// label is PRESENT first and only THEN cleared proves the drop-effect ran —
		// a bare end-state `toBeNull()` would pass vacuously (it holds during the
		// pre-render gap too, so it can't tell "cleared" from "never shown").
		let codexConnected = true;
		const settingsResult = {
			provider: "openai-codex",
			model: "gpt-5.5",
			effort: "off",
			enabled_models: ["gpt-5.5"],
		};
		const stub = stubWsClient({
			providerStatus: () =>
				Effect.succeed({
					providers: [
						{
							id: "openai-codex",
							connected: codexConnected,
							auth_kind: "oauth" as const,
						},
					],
				}),
			modelCatalog: () => Effect.succeed(CATALOG),
			settingsGet: () => Effect.succeed(settingsResult),
			settingsSet: () => Effect.succeed(settingsResult),
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<RuntimeProvider runtime={runtime}>
					<ModelPicker />
				</RuntimeProvider>
			</QueryClientProvider>,
		);

		// Connected first → the trigger shows the selected model's name.
		expect(await screen.findByText("GPT-5.5")).toBeInTheDocument();

		// Provider disconnects; refetch the shared status query so the picker sees it.
		codexConnected = false;
		await client.invalidateQueries({ queryKey: ["provider-status"] });

		// The stale selection is dropped — "GPT-5.5" clears from the trigger.
		await waitFor(() => expect(screen.queryByText("GPT-5.5")).toBeNull());

		await runtime.dispose();
	});

	it("makes a known-provider model selectable once provider/status resolves connected", async () => {
		const user = userEvent.setup();
		// Once status resolves with the provider connected, the same model becomes a
		// real, enabled choice — the tri-state collapses back to the loaded behavior.
		const runtime = makeRuntime(["gpt-5.5"], {
			providers: [
				{ id: "openai-codex", connected: true, auth_kind: "oauth" as const },
			],
		});
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ModelPicker />
			</RuntimeProvider>,
		);

		await user.click(screen.getByRole("button", { name: /select model/i }));
		const list = await screen.findByRole("list");

		// The connected provider's model is selectable.
		await waitFor(() => {
			const row = within(list).getByText("GPT-5.5").closest("button");
			expect(row).not.toBeNull();
			expect(row).not.toBeDisabled();
		});

		// Picking it updates the trigger to the model's name.
		const row = within(list).getByText("GPT-5.5").closest("button");
		if (row) await user.click(row);
		expect(await screen.findByText("GPT-5.5")).toBeInTheDocument();

		await runtime.dispose();
	});

	it("shows no catalog model before settings load (no pre-load flash)", async () => {
		const user = userEvent.setup();
		// Catalog resolves but settings/get never does: the async gap a curated
		// user would have flashed the full catalog through. Pre-load, the list
		// must be empty — never a disabled model, even for one frame.
		const runtime = makeRuntime(["gpt-5.5"], { settingsPending: true });
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ModelPicker />
			</RuntimeProvider>,
		);

		await user.click(screen.getByRole("button", { name: /select model/i }));

		const list = await screen.findByRole("list");
		// Neither model is offered while settings are pending — in particular the
		// disabled "GPT-5.4 Mini" is never shown.
		expect(within(list).queryByText("GPT-5.5")).toBeNull();
		expect(within(list).queryByText("GPT-5.4 Mini")).toBeNull();
		expect(within(list).getByText(/no models available/i)).toBeInTheDocument();

		await runtime.dispose();
	});
});
