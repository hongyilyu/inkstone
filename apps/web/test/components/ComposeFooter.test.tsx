import { stubWsClient, WsClient } from "@inkstone/ui-sdk";
import { renderWithQuery } from "@test/test-utils/renderWithQuery";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeFooter } from "@/components/ComposeFooter.js";
import { RuntimeProvider } from "@/runtime";

afterEach(cleanup);

// jsdom ships no URL.createObjectURL/revokeObjectURL; the pending-thumbnail
// strip mints an object URL per attached file, so stub both with observable
// fakes (unique per call — two same-named files must not collide as keys).
let objectUrlSeq = 0;
const createObjectURL = vi.fn(() => `blob:mock-${objectUrlSeq++}`);
const revokeObjectURL = vi.fn();
Object.assign(URL, { createObjectURL, revokeObjectURL });

beforeEach(() => {
	createObjectURL.mockClear();
	revokeObjectURL.mockClear();
});

function makeImageFile(name = "photo.png") {
	return new File(["png-bytes"], name, { type: "image/png" });
}

/** The hidden file input behind the Attach chip. */
function fileInput(container: HTMLElement): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>('input[type="file"]');
	if (!input) throw new Error("hidden file input not rendered");
	return input;
}

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
		expect(onSend).toHaveBeenCalledWith("hello", []);

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

		// Search has no Core backing yet, so it ships disabled rather than
		// masquerading as a live control. Attach IS live now (slice 5) — the media
		// substrate backs it — so it must be enabled.
		expect(
			screen.getByRole("button", { name: /search \(coming soon\)/i }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: /^attach$/i })).toBeEnabled();

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

	it("shows a pending thumbnail when a file is picked via the Attach chip's input", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		const runtime = makeRuntime();
		const { container } = renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ComposeFooter onSend={onSend} />
			</RuntimeProvider>,
		);

		// The picker input is hidden chrome behind the chip — image/* + multiple so
		// one pick can carry several photos.
		const input = fileInput(container);
		expect(input.accept).toBe("image/*");
		expect(input.multiple).toBe(true);

		await user.upload(input, makeImageFile());

		// A pending thumbnail materializes from an object URL of the picked file.
		const thumb = await screen.findByRole("img", { name: /photo\.png/i });
		expect(thumb).toHaveAttribute("src", expect.stringMatching(/^blob:/));
		expect(createObjectURL).toHaveBeenCalledTimes(1);

		await runtime.dispose();
	});

	it("adds a pending thumbnail for a pasted image but ignores non-image pastes", async () => {
		const onSend = vi.fn();
		const runtime = makeRuntime();
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ComposeFooter onSend={onSend} />
			</RuntimeProvider>,
		);
		const textbox = screen.getByRole("textbox");

		// Pasting an image from the clipboard attaches it (screenshot workflow).
		fireEvent.paste(textbox, {
			clipboardData: { files: [makeImageFile("pasted.png")] },
		});
		expect(
			await screen.findByRole("img", { name: /pasted\.png/i }),
		).toBeInTheDocument();

		// A non-image file on the clipboard is NOT attached (composer is image/*
		// only) — no second thumbnail appears.
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [new File(["%PDF"], "doc.pdf", { type: "application/pdf" })],
			},
		});
		expect(screen.getAllByRole("img")).toHaveLength(1);

		await runtime.dispose();
	});

	it("adds a pending thumbnail for an image dropped onto the composer", async () => {
		const onSend = vi.fn();
		const runtime = makeRuntime();
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ComposeFooter onSend={onSend} />
			</RuntimeProvider>,
		);

		fireEvent.drop(screen.getByRole("textbox"), {
			dataTransfer: { files: [makeImageFile("dropped.png")] },
		});

		expect(
			await screen.findByRole("img", { name: /dropped\.png/i }),
		).toBeInTheDocument();

		await runtime.dispose();
	});

	it("submits (text, files), clears the pending strip, and revokes the object URLs", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		const runtime = makeRuntime();
		const { container } = renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ComposeFooter onSend={onSend} />
			</RuntimeProvider>,
		);

		const file = makeImageFile();
		await user.upload(fileInput(container), file);
		await screen.findByRole("img", { name: /photo\.png/i });
		await user.type(screen.getByRole("textbox"), "look at this");
		await user.click(screen.getByRole("button", { name: /send/i }));

		expect(onSend).toHaveBeenCalledTimes(1);
		expect(onSend).toHaveBeenCalledWith("look at this", [file]);

		// The pending strip clears with the text, and its object URL is released
		// (the sent bubble re-renders from /media/{id}, not the blob).
		expect(screen.queryByRole("img")).toBeNull();
		expect(revokeObjectURL).toHaveBeenCalledTimes(1);

		await runtime.dispose();
	});

	it("removes a single pending attachment via its per-item remove button", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		const runtime = makeRuntime();
		const { container } = renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ComposeFooter onSend={onSend} />
			</RuntimeProvider>,
		);

		const keep = makeImageFile("keep.png");
		const drop = makeImageFile("drop.png");
		await user.upload(fileInput(container), [keep, drop]);
		expect(await screen.findAllByRole("img")).toHaveLength(2);

		await user.click(screen.getByRole("button", { name: /remove drop\.png/i }));

		// Only the removed thumbnail goes; its object URL is revoked; the survivor
		// still rides the next send.
		expect(screen.getAllByRole("img")).toHaveLength(1);
		expect(screen.getByRole("img", { name: /keep\.png/i })).toBeInTheDocument();
		expect(revokeObjectURL).toHaveBeenCalledTimes(1);

		await user.type(screen.getByRole("textbox"), "just the keeper");
		await user.click(screen.getByRole("button", { name: /send/i }));
		expect(onSend).toHaveBeenCalledWith("just the keeper", [keep]);

		await runtime.dispose();
	});

	it("revokes pending object URLs when unmounted with attachments still pending", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		const runtime = makeRuntime();
		const { container, unmount } = renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ComposeFooter onSend={onSend} />
			</RuntimeProvider>,
		);

		await user.upload(fileInput(container), makeImageFile());
		const thumb = await screen.findByRole("img", { name: /photo\.png/i });
		const mintedUrl = thumb.getAttribute("src");

		// Unmounting with the attachment still pending must release its blob URL
		// (neither send nor remove ran, so nothing else would).
		unmount();
		expect(revokeObjectURL).toHaveBeenCalledTimes(1);
		expect(revokeObjectURL).toHaveBeenCalledWith(mintedUrl);

		await runtime.dispose();
	});

	it("still requires text: submit with pending files but no text no-ops", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		const runtime = makeRuntime();
		const { container } = renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ComposeFooter onSend={onSend} />
			</RuntimeProvider>,
		);

		await user.upload(fileInput(container), makeImageFile());
		await screen.findByRole("img", { name: /photo\.png/i });

		// Image-only sends are out of scope — text is still the gate. The pending
		// thumbnail must survive the no-op (nothing was sent, nothing clears).
		await user.click(screen.getByRole("button", { name: /send/i }));
		await user.type(screen.getByRole("textbox"), "{Enter}");
		expect(onSend).not.toHaveBeenCalled();
		expect(
			screen.getByRole("img", { name: /photo\.png/i }),
		).toBeInTheDocument();

		await runtime.dispose();
	});
});
