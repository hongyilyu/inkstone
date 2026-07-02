import { stubWsClient, WsClient } from "@inkstone/ui-sdk";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { renderWithQuery } from "@test/test-utils/renderWithQuery";
import { ModelPicker } from "@/components/ModelPicker.js";

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

	it("disables a model whose provider is not connected (FIX #3)", async () => {
		const user = userEvent.setup();
		// Both models enabled, but openrouter is NOT connected: its model must be
		// offered-but-locked (a run against it would be tokenless), while the
		// connected codex model stays selectable.
		const runtime = makeRuntime(["gpt-5.5", "anthropic/claude-opus-4.8"]);
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ModelPicker />
			</RuntimeProvider>,
		);

		await user.click(screen.getByRole("button", { name: /select model/i }));
		const list = await screen.findByRole("list");

		// The connected provider's model is a real, enabled choice.
		const codexRow = within(list).getByText("GPT-5.5").closest("button");
		expect(codexRow).not.toBeNull();
		expect(codexRow).not.toBeDisabled();

		// The disconnected provider's model is shown but locked, with a hint.
		const orRow = within(list).getByText("Claude Opus 4.8").closest("button");
		expect(orRow).not.toBeNull();
		expect(orRow).toBeDisabled();
		expect(orRow).toHaveAttribute(
			"title",
			expect.stringMatching(/connect.*provider/i),
		);

		// Clicking the locked row does NOT change the selection (the trigger still
		// invites a pick rather than showing the locked model's name).
		if (orRow) await user.click(orRow);
		expect(
			screen.getByRole("button", { name: /select model/i }),
		).toBeInTheDocument();

		await runtime.dispose();
	});

	it("does NOT let a known-provider model be selected while provider/status is unresolved (no fail-open)", async () => {
		const user = userEvent.setup();
		// Catalog + settings resolve, but provider/status never does: connectivity is
		// unknown. A known-provider model must NOT be selectable in this gap — the
		// picker is the only gate on selection (the #3 run-path guard is web-only), so
		// failing open would let a disconnected-provider model be picked before status
		// confirms it. gpt-5.5 belongs to a KNOWN provider group (openai-codex).
		const runtime = makeRuntime(["gpt-5.5"], { statusPending: true });
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ModelPicker />
			</RuntimeProvider>,
		);

		await user.click(screen.getByRole("button", { name: /select model/i }));
		const list = await screen.findByRole("list");

		// The model is shown but LOCKED (disabled + connect hint) while status is
		// unresolved — not selectable.
		const row = within(list).getByText("GPT-5.5").closest("button");
		expect(row).not.toBeNull();
		expect(row).toBeDisabled();
		expect(row).toHaveAttribute(
			"title",
			expect.stringMatching(/connect.*provider/i),
		);

		// Clicking it does NOT change the selection.
		if (row) await user.click(row);
		expect(
			screen.getByRole("button", { name: /select model/i }),
		).toBeInTheDocument();

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
