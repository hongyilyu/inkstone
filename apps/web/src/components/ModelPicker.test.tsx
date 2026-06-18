import { WsClient, type WsError } from "@inkstone/ui-sdk";
import { cleanup, screen } from "@testing-library/react";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import { ModelPicker } from "./ModelPicker.js";

afterEach(cleanup);

const die = (): Effect.Effect<never, never> => Effect.die("unused");
const dieStream = (): Stream.Stream<never, WsError> =>
	Stream.fromEffect(Effect.die("unused")) as Stream.Stream<never, WsError>;

/** A stub runtime whose catalog + settings feed the picker. `settings` is the
 *  literal `settings/get` returns — vary `model`/`default_model` per case. */
function makeRuntime(settings: {
	model: string | null;
	default_model?: string;
}) {
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
		providerStatus: die,
		providerLoginStart: die,
		modelCatalog: () =>
			Effect.succeed({
				providers: [
					{
						id: "openai-codex",
						label: "OpenAI",
						models: [
							{
								id: "gpt-5.4",
								name: "GPT-5.4",
								reasoning: true,
								input: ["text", "image"],
								cost_input: 2.5,
								cost_output: 15,
							},
							{
								id: "gpt-5.5",
								name: "GPT-5.5",
								reasoning: true,
								input: ["text", "image"],
								cost_input: 5,
								cost_output: 30,
							},
						],
					},
				],
			}),
		settingsGet: () =>
			Effect.succeed({ provider: "openai-codex", effort: "off", ...settings }),
		settingsSet: die,
		proposalGet: die,
		proposalDecide: die,
		messageSearch: die,
		proposalNotifications: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

describe("ModelPicker", () => {
	it("shows the per-provider default when no model is preferred yet", async () => {
		const runtime = makeRuntime({ model: null, default_model: "gpt-5.5" });
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ModelPicker />
			</RuntimeProvider>,
		);

		// The placeholder must NOT win: a fresh setup reflects the model a Run
		// would actually use.
		expect(await screen.findByText(/GPT-5\.5/)).toBeInTheDocument();
		expect(screen.queryByText("Select model")).toBeNull();

		await runtime.dispose();
	});

	it("shows the picked model over the default when a preference is set", async () => {
		const runtime = makeRuntime({ model: "gpt-5.4", default_model: "gpt-5.5" });
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ModelPicker />
			</RuntimeProvider>,
		);

		expect(await screen.findByText(/GPT-5\.4/)).toBeInTheDocument();

		await runtime.dispose();
	});
});
