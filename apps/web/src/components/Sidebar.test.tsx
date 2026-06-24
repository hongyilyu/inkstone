import { type RunEventValue, WsClient } from "@inkstone/ui-sdk";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBridge } from "@/store/bridge";
import { resetChatStore } from "@/store/chat";
import { renderChatRoute } from "@/test-utils/renderChatRoute";
import { ChatColumn } from "./ChatColumn.js";
import { Sidebar } from "./Sidebar.js";

// Stub WsClient whose `threadList` returns a fixed set of threads.
function makeStubRuntime() {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () =>
			Effect.succeed({
				threads: [
					{ id: "t-1", title: "Standup digest", last_activity_at: 2 },
					{ id: "t-2", title: "API rename plan", last_activity_at: 1 },
				],
			}),
		threadGet: () => unused,
		getRunHistory: () => Effect.die("not exercised"),
		listEntities: () => unused,
		getBacklinks: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => unused,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

// Stub whose thread list grows on `threadCreate`, so a fresh read after creation includes the new thread.
function makeGrowingStubRuntime(opts: {
	readonly newThreadId: string;
	readonly runId: string;
	readonly events: readonly RunEventValue[];
}) {
	const threads: { id: string; title: string; last_activity_at: number }[] = [];
	const stub = WsClient.of({
		threadCreate: (prompt: string) =>
			Effect.sync(() => {
				threads.unshift({
					id: opts.newThreadId,
					title: prompt,
					last_activity_at: threads.length + 1,
				});
				return { thread_id: opts.newThreadId, run_id: opts.runId };
			}),
		postMessage: () => Effect.succeed(opts.runId),
		threadList: () => Effect.sync(() => ({ threads: [...threads] })),
		getRunHistory: () => Effect.die("not exercised"),
		threadGet: () => Effect.die("not exercised"),
		listEntities: () => Effect.die("not exercised"),
		getBacklinks: () => Effect.die("not exercised"),
		entityMutate: () => Effect.die("not exercised"),
		subscribeRun: () => Stream.fromIterable(opts.events),
		cancelRun: () => Effect.die("not exercised"),
		providerStatus: () => Effect.die("not exercised"),
		providerLoginStart: () => Effect.die("not exercised"),
		modelCatalog: () => Effect.die("not exercised"),
		settingsGet: () => Effect.die("not exercised"),
		settingsSet: () => Effect.die("not exercised"),
		proposalGet: () => Effect.die("not exercised"),
		proposalDecide: () => Effect.die("not exercised"),
		messageSearch: () => Effect.die("not exercised"),
		proposalNotifications: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

beforeEach(() => {
	resetChatStore();
	resetBridge();
});

afterEach(() => {
	cleanup();
});

describe("Sidebar", () => {
	it("lists threads from a thread/list read and asks to open one on click", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime();
		const onOpenThread = vi.fn();

		renderChatRoute(<Sidebar onOpenThread={onOpenThread} />, { runtime });

		const first = await screen.findByText("Standup digest");
		expect(await screen.findByText("API rename plan")).toBeInTheDocument();

		await user.click(first);

		// Thread focus is the URL (ADR-0042): the row asks its parent to navigate.
		expect(onOpenThread).toHaveBeenCalledWith("t-1");

		await runtime.dispose();
	});

	it("marks the row matching the focused-thread route as current", async () => {
		const runtime = makeStubRuntime();

		// Mounted at /thread/t-2 → the "API rename plan" row is the current one.
		renderChatRoute(<Sidebar />, { runtime, path: "/thread/t-2" });

		const current = await screen.findByRole("button", {
			name: "API rename plan",
		});
		expect(current).toHaveAttribute("aria-current", "true");
		const other = screen.getByRole("button", { name: "Standup digest" });
		expect(other).not.toHaveAttribute("aria-current");

		await runtime.dispose();
	});

	it("keeps the New Chat button and fires its handler on click", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime();
		const onNewChat = vi.fn();

		renderChatRoute(<Sidebar onNewChat={onNewChat} />, {
			runtime,
			path: "/thread/t-1",
		});

		await screen.findByText("Standup digest");
		await user.click(screen.getByRole("button", { name: /new chat/i }));
		expect(onNewChat).toHaveBeenCalledTimes(1);

		await runtime.dispose();
	});

	it("shows a newly-created thread without a manual reload", async () => {
		const user = userEvent.setup();
		const runtime = makeGrowingStubRuntime({
			newThreadId: "thread-new",
			runId: "run-1",
			events: [{ kind: "text_delta", delta: "echo: hi" }, { kind: "done" }],
		});

		// Sidebar + ChatColumn share one runtime + router — the real app wiring. The
		// Sidebar's New Chat / open-thread navigations are unused here; the send path
		// drives ChatColumn, which invalidates ["threads"] so the sidebar re-reads.
		renderChatRoute(
			<>
				<Sidebar />
				<ChatColumn />
			</>,
			{ runtime, path: "/" },
		);

		expect(await screen.findByText(/no threads yet/i)).toBeInTheDocument();

		await user.type(screen.getByRole("textbox", { name: /message/i }), "hi");
		await user.click(screen.getByRole("button", { name: /send/i }));

		// Sidebar surfaces the minted thread (title = prompt), proving thread/list was invalidated on create.
		expect(
			await screen.findByRole("button", { name: "hi" }),
		).toBeInTheDocument();

		await runtime.dispose();
	});

	it("carries the documented focus-visible ring on its hand-rolled buttons", async () => {
		const runtime = makeStubRuntime();

		renderChatRoute(<Sidebar />, { runtime });

		// DESIGN.md: the 1px ring-ring on focus-visible is "Never removed" — the
		// hand-rolled New Chat / thread-open / copy-id buttons must all carry it.
		const threadOpen = await screen.findByRole("button", {
			name: "Standup digest",
		});
		const newChat = screen.getByRole("button", { name: /new chat/i });
		const copyId = screen.getByRole("button", {
			name: /copy thread id for standup digest/i,
		});

		for (const btn of [newChat, threadOpen, copyId]) {
			expect(btn.className).toContain("focus-visible:ring-ring");
			expect(btn.className).toContain("focus-visible:ring-1");
		}

		await runtime.dispose();
	});

	it("copies a thread's id to the clipboard from its row button", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime();

		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});

		renderChatRoute(<Sidebar />, { runtime });

		// Copy-id control writes the thread id (not its title) to the clipboard.
		const copyBtn = await screen.findByRole("button", {
			name: /copy thread id for standup digest/i,
		});
		await user.click(copyBtn);

		expect(writeText).toHaveBeenCalledWith("t-1");

		await runtime.dispose();
	});

	it("confirms a successful copy with a 'Copied' affordance", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime();

		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn(() => Promise.resolve()) },
			configurable: true,
		});

		renderChatRoute(<Sidebar />, { runtime });

		const copyBtn = await screen.findByRole("button", {
			name: /copy thread id for standup digest/i,
		});
		await user.click(copyBtn);

		// The button flips its title to "Copied" so the click has visible feedback
		// (only on a write that actually resolved — never a fake success).
		await waitFor(() => expect(copyBtn).toHaveAttribute("title", "Copied"));

		await runtime.dispose();
	});

	it("shows 'Couldn't copy' (never a fake checkmark) when the clipboard write fails", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime();

		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) },
			configurable: true,
		});

		renderChatRoute(<Sidebar />, { runtime });

		const copyBtn = await screen.findByRole("button", {
			name: /copy thread id for standup digest/i,
		});
		await user.click(copyBtn);

		await waitFor(() =>
			expect(copyBtn).toHaveAttribute("title", "Couldn't copy"),
		);
		expect(copyBtn).not.toHaveAttribute("title", "Copied");

		await runtime.dispose();
	});
});
