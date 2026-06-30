import { WsClient, type WsError } from "@inkstone/ui-sdk";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import { ModelPicker } from "./ModelPicker.js";

afterEach(cleanup);

const die = (): Effect.Effect<never, never> => Effect.die("unused");
const dieStream = (): Stream.Stream<never, WsError> =>
	Stream.fromEffect(Effect.die("unused")) as Stream.Stream<never, WsError>;

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
	],
} as const;

/** A stub runtime whose catalog has two models; settings decide which are enabled. */
function makeRuntime(
	enabledModels: readonly string[],
	{ settingsPending = false }: { settingsPending?: boolean } = {},
) {
	const settingsResult = {
		provider: "openai-codex",
		model: "gpt-5.5",
		effort: "off",
		enabled_models: enabledModels,
	};
	const stub = WsClient.of({
		threadCreate: die,
		postMessage: die,
		threadList: die,
		getRunHistory: die,
		recurrencePreview: () => Effect.die("not exercised in this test"),
		threadGet: die,
		threadRename: die,
		threadArchive: die,
		threadUnarchive: die,
		threadListArchived: die,
		listEntities: die,
		getBacklinks: die,
		observationQuery: die,
		observationUpdate: die,
		entityMutate: die,
		subscribeRun: dieStream,
		cancelRun: die,
		retryRun: die,
		providerStatus: die,
		providerLoginStart: die,
		modelCatalog: () => Effect.succeed(CATALOG),
		// When `settingsPending`, settings/get never resolves — modelling the
		// async gap where the catalog has loaded but settings have not.
		settingsGet: () =>
			settingsPending ? Effect.never : Effect.succeed(settingsResult),
		settingsSet: () => Effect.succeed(settingsResult),
		proposalGet: die,
		rescanJournalEntry: die,
		proposalDecide: die,
		messageSearch: die,
		proposalNotifications: () => Stream.empty,
		connectionStatus: () => Stream.empty,
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
