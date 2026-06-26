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
		threadRename: () => unused,
		threadArchive: () => unused,
		threadUnarchive: () => unused,
		threadListArchived: () => unused,
		getRunHistory: () => Effect.die("not exercised"),
		recurrencePreview: () => Effect.die("not exercised in this test"),
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
		rescanJournalEntry: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => unused,
		connectionStatus: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

// Stub WsClient whose `threadRename`/`threadArchive` RECORD their calls (instead
// of the `Effect.die` placeholders in makeStubRuntime), so the rename/archive
// ACTIONS can be asserted. `threadList` returns the same fixed pair.
function makeRecordingRuntime() {
	const unused = Effect.die("not exercised in this test");
	const threadRename = vi.fn((_id: string, _title: string) => {});
	const threadArchive = vi.fn((_id: string) => {});
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
		threadRename: (threadId: string, title: string) =>
			Effect.sync(() => {
				threadRename(threadId, title);
				return { thread_id: threadId };
			}),
		threadArchive: (threadId: string) =>
			Effect.sync(() => {
				threadArchive(threadId);
				return { thread_id: threadId };
			}),
		threadUnarchive: () => unused,
		threadListArchived: () => unused,
		getRunHistory: () => Effect.die("not exercised"),
		recurrencePreview: () => Effect.die("not exercised in this test"),
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
		rescanJournalEntry: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => unused,
		connectionStatus: () => Stream.empty,
	});
	return {
		runtime: ManagedRuntime.make(Layer.succeed(WsClient, stub)),
		threadRename,
		threadArchive,
	};
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
		recurrencePreview: () => Effect.die("not exercised in this test"),
		threadGet: () => Effect.die("not exercised"),
		threadRename: () => Effect.die("not exercised"),
		threadArchive: () => Effect.die("not exercised"),
		threadUnarchive: () => Effect.die("not exercised"),
		threadListArchived: () => Effect.die("not exercised"),
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
		rescanJournalEntry: () => Effect.die("not exercised"),
		proposalDecide: () => Effect.die("not exercised"),
		messageSearch: () => Effect.die("not exercised"),
		proposalNotifications: () => Stream.empty,
		connectionStatus: () => Stream.empty,
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

	it("inline rename commits on Enter and cancels on Escape", async () => {
		const user = userEvent.setup();
		const { runtime, threadRename } = makeRecordingRuntime();

		renderChatRoute(<Sidebar />, { runtime });

		// Double-click the title → an input seeded with the current title appears.
		const title = await screen.findByRole("button", { name: "Standup digest" });
		await user.dblClick(title);
		const input = screen.getByRole("textbox", { name: /rename thread/i });
		expect(input).toHaveValue("Standup digest");

		// Type a new title + Enter → threadRename(id, newTitle), input gone.
		await user.clear(input);
		await user.type(input, "Daily standup{Enter}");
		await waitFor(() =>
			expect(threadRename).toHaveBeenCalledWith("t-1", "Daily standup"),
		);
		expect(
			screen.queryByRole("textbox", { name: /rename thread/i }),
		).not.toBeInTheDocument();

		// Re-open then Escape → input gone, title unchanged, NO further rename call.
		await user.dblClick(
			await screen.findByRole("button", { name: "API rename plan" }),
		);
		const second = screen.getByRole("textbox", { name: /rename thread/i });
		await user.clear(second);
		await user.type(second, "scrapped{Escape}");
		expect(
			screen.queryByRole("textbox", { name: /rename thread/i }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "API rename plan" }),
		).toBeInTheDocument();
		expect(threadRename).toHaveBeenCalledTimes(1);

		await runtime.dispose();
	});

	it("inline rename is a no-op on an empty title", async () => {
		const user = userEvent.setup();
		const { runtime, threadRename } = makeRecordingRuntime();

		renderChatRoute(<Sidebar />, { runtime });

		// Double-click → clear the field to empty → Enter. The commit guard
		// (`trimmed && …`) treats a blank title as a no-op: no threadRename, and
		// the row falls back to its original title (Core rejects empty anyway).
		await user.dblClick(
			await screen.findByRole("button", { name: "Standup digest" }),
		);
		const input = screen.getByRole("textbox", { name: /rename thread/i });
		await user.clear(input);
		await user.type(input, "{Enter}");

		expect(threadRename).toHaveBeenCalledTimes(0);
		expect(
			screen.queryByRole("textbox", { name: /rename thread/i }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Standup digest" }),
		).toBeInTheDocument();

		await runtime.dispose();
	});

	it("inline rename is a no-op on a whitespace-only title", async () => {
		const user = userEvent.setup();
		const { runtime, threadRename } = makeRecordingRuntime();

		renderChatRoute(<Sidebar />, { runtime });

		// Whitespace trims to empty → same no-op branch as a blank field.
		await user.dblClick(
			await screen.findByRole("button", { name: "Standup digest" }),
		);
		const input = screen.getByRole("textbox", { name: /rename thread/i });
		await user.clear(input);
		await user.type(input, "   {Enter}");

		expect(threadRename).toHaveBeenCalledTimes(0);
		expect(
			screen.queryByRole("textbox", { name: /rename thread/i }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Standup digest" }),
		).toBeInTheDocument();

		await runtime.dispose();
	});

	it("inline rename is a no-op when the title is unchanged", async () => {
		const user = userEvent.setup();
		const { runtime, threadRename } = makeRecordingRuntime();

		renderChatRoute(<Sidebar />, { runtime });

		// Double-click → Enter without editing. `trimmed !== item.title` is false,
		// so the commit guard skips threadRename even though the input is non-empty.
		await user.dblClick(
			await screen.findByRole("button", { name: "Standup digest" }),
		);
		const input = screen.getByRole("textbox", { name: /rename thread/i });
		expect(input).toHaveValue("Standup digest");
		await user.type(input, "{Enter}");

		expect(threadRename).toHaveBeenCalledTimes(0);
		expect(
			screen.queryByRole("textbox", { name: /rename thread/i }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Standup digest" }),
		).toBeInTheDocument();

		await runtime.dispose();
	});

	it("inline rename commits on blur", async () => {
		const user = userEvent.setup();
		const { runtime, threadRename } = makeRecordingRuntime();

		renderChatRoute(<Sidebar />, { runtime });

		// Double-click → type a new title → blur (focus moves away via Tab). The
		// input's onBlur is wired to commit, so a changed title persists even
		// without pressing Enter.
		await user.dblClick(
			await screen.findByRole("button", { name: "Standup digest" }),
		);
		const input = screen.getByRole("textbox", { name: /rename thread/i });
		await user.clear(input);
		await user.type(input, "Daily standup");
		await user.tab();

		await waitFor(() =>
			expect(threadRename).toHaveBeenCalledWith("t-1", "Daily standup"),
		);
		expect(threadRename).toHaveBeenCalledTimes(1);
		expect(
			screen.queryByRole("textbox", { name: /rename thread/i }),
		).not.toBeInTheDocument();

		await runtime.dispose();
	});

	it("archiving the focused thread navigates to the welcome route", async () => {
		const user = userEvent.setup();
		const { runtime, threadArchive } = makeRecordingRuntime();
		const onNewChat = vi.fn();

		// Focused on t-1: archiving it must reselect via onNewChat (→ "/").
		renderChatRoute(<Sidebar onNewChat={onNewChat} />, {
			runtime,
			path: "/thread/t-1",
		});

		await screen.findByText("Standup digest");
		await user.click(
			screen.getByRole("button", { name: "Archive thread Standup digest" }),
		);

		// The reselect fires on the mutation's SUCCESS, so await it.
		await waitFor(() => expect(threadArchive).toHaveBeenCalledWith("t-1"));
		await waitFor(() => expect(onNewChat).toHaveBeenCalledTimes(1));

		await runtime.dispose();
	});

	it("the Archived nav row calls onOpenArchived", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime();
		const onOpenArchived = vi.fn();

		renderChatRoute(<Sidebar onOpenArchived={onOpenArchived} />, { runtime });

		await user.click(
			await screen.findByRole("button", { name: /^archived$/i }),
		);
		expect(onOpenArchived).toHaveBeenCalledTimes(1);

		await runtime.dispose();
	});

	it("archiving a non-focused thread does NOT navigate", async () => {
		const user = userEvent.setup();
		const { runtime, threadArchive } = makeRecordingRuntime();
		const onNewChat = vi.fn();

		// Focused on t-1; archive t-2 → no reselect.
		renderChatRoute(<Sidebar onNewChat={onNewChat} />, {
			runtime,
			path: "/thread/t-1",
		});

		await screen.findByText("API rename plan");
		await user.click(
			screen.getByRole("button", { name: "Archive thread API rename plan" }),
		);

		await waitFor(() => expect(threadArchive).toHaveBeenCalledWith("t-2"));
		expect(onNewChat).not.toHaveBeenCalled();

		await runtime.dispose();
	});
});
