import { stubWsClient, WsClient } from "@inkstone/ui-sdk";
import { renderWithQuery } from "@test/test-utils/renderWithQuery";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeFooter } from "@/components/ComposeFooter.js";
import { RuntimeProvider } from "@/runtime";

afterEach(cleanup);

/** A stub runtime whose catalog + settings feed the composer's ModelPicker. */
function makeRuntime() {
	const stub = stubWsClient({
		modelCatalog: () =>
			Effect.succeed({
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
						],
					},
				],
			}),
		settingsGet: () =>
			Effect.succeed({
				provider: "openai-codex",
				model: "gpt-5.5",
				effort: "off",
				enabled_models: [],
			}),
		settingsSet: () =>
			Effect.succeed({
				provider: "openai-codex",
				model: "gpt-5.5",
				effort: "off",
				enabled_models: [],
			}),
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

describe("ComposeFooter", () => {
	it("calls onSend with the typed text and renders the model + effort strip", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		const runtime = makeRuntime();
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ComposeFooter onSend={onSend} />
			</RuntimeProvider>,
		);

		await user.type(screen.getByRole("textbox"), "hello");
		await user.click(screen.getByRole("button", { name: /send/i }));

		expect(onSend).toHaveBeenCalledTimes(1);
		expect(onSend).toHaveBeenCalledWith("hello");

		// The model picker trigger is present; once the preferred model loads
		// (`gpt-5.5`), the trigger's accessible name reflects it WITH its provider
		// tag — assert the full name so this can't pass if the tag regressed.
		expect(
			await screen.findByRole("button", { name: "GPT-5.5 (OpenAI)" }),
		).toBeInTheDocument();

		// The effort picker reflects the global effort from settings (`off`).
		expect(
			screen.getByRole("button", { name: /reasoning effort/i }),
		).toBeInTheDocument();
		expect(await screen.findByText(/^Off$/)).toBeInTheDocument();

		// Search + Attach have no Core backing yet, so they ship disabled rather
		// than masquerading as live controls. Their accessible name carries the
		// "(coming soon)" reason (see the dedicated test below).
		expect(
			screen.getByRole("button", { name: /search \(coming soon\)/i }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: /attach \(coming soon\)/i }),
		).toBeDisabled();

		await runtime.dispose();
	});

	it("folds the unavailable reason into the accessible name of the placeholder chips", async () => {
		const onSend = vi.fn();
		const runtime = makeRuntime();
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ComposeFooter onSend={onSend} />
			</RuntimeProvider>,
		);

		// A disabled native button is out of the tab order, so the `title` tooltip
		// is unreachable by keyboard/touch/AT — the reason must live in the
		// accessible name instead.
		expect(
			screen.getByRole("button", { name: /search \(coming soon\)/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /attach \(coming soon\)/i }),
		).toBeInTheDocument();

		await runtime.dispose();
	});

	it("does not send when disabled, but keeps the textarea editable", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		const runtime = makeRuntime();
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ComposeFooter onSend={onSend} disabled />
			</RuntimeProvider>,
		);

		// The textarea STAYS editable so the user can draft a message before
		// connecting a provider — only the Send affordance is gated.
		const textbox = screen.getByRole("textbox");
		expect(textbox).not.toBeDisabled();
		await user.type(textbox, "drafted while disconnected");
		expect(textbox).toHaveValue("drafted while disconnected");

		// Send is gated: the button is disabled and neither click nor Enter fires.
		const send = screen.getByRole("button", { name: /send/i });
		expect(send).toBeDisabled();
		await user.click(send);
		await user.type(textbox, "{Enter}");
		expect(onSend).not.toHaveBeenCalled();

		await runtime.dispose();
	});

	it("swaps Send for a Stop control while a Run is active and routes clicks to onStop", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		const onStop = vi.fn();
		const runtime = makeRuntime();
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ComposeFooter onSend={onSend} isRunning onStop={onStop} />
			</RuntimeProvider>,
		);

		// Send is gone; Stop is the primary control.
		expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
		await user.click(screen.getByRole("button", { name: /stop/i }));
		expect(onStop).toHaveBeenCalledTimes(1);

		// Enter must not start a second turn over the live Run.
		await user.type(screen.getByRole("textbox"), "queued{Enter}");
		expect(onSend).not.toHaveBeenCalled();

		await runtime.dispose();
	});
});
