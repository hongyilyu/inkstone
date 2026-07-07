import type { RunEventValue, WsClientService, WsError } from "@inkstone/ui-sdk";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatColumn } from "@/components/ChatColumn.js";
import { Sidebar } from "@/components/Sidebar.js";
import { resetBridge } from "@/store/bridge";
import { resetChatStore } from "@/store/chat";

// Stub WsClient whose `threadList` returns a fixed set of threads.
function makeStubOverrides(): Partial<WsClientService> {
	return {
		threadList: () =>
			Effect.succeed({
				threads: [
					{ id: "t-1", title: "Standup digest", last_activity_at: 2 },
					{ id: "t-2", title: "API rename plan", last_activity_at: 1 },
				],
			}),
	};
}

// Stub WsClient whose `threadRename`/`threadArchive` RECORD their calls (instead
// of the `Effect.die` placeholders in makeStubOverrides), so the rename/archive
// ACTIONS can be asserted. `threadList` returns the same fixed pair.
function makeRecordingOverrides() {
	const threadRename = vi.fn((_id: string, _title: string) => {});
	const threadArchive = vi.fn((_id: string) => {});
	const overrides: Partial<WsClientService> = {
		threadList: () =>
			Effect.succeed({
				threads: [
					{ id: "t-1", title: "Standup digest", last_activity_at: 2 },
					{ id: "t-2", title: "API rename plan", last_activity_at: 1 },
				],
			}),
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
	};
	return {
		overrides,
		threadRename,
		threadArchive,
	};
}

// Stub whose `threadRename` FAILS, so the row's failure surface (inline alert +
// stays in edit mode with the typed title intact) can be asserted.
function makeFailingRenameOverrides(): Partial<WsClientService> {
	return {
		threadList: () =>
			Effect.succeed({
				threads: [
					{ id: "t-1", title: "Standup digest", last_activity_at: 2 },
					{ id: "t-2", title: "API rename plan", last_activity_at: 1 },
				],
			}),
		threadRename: () =>
			Effect.fail({
				_tag: "WsRequestError",
				reason: "connection_lost",
			} as WsError),
	};
}

// Stub whose thread list grows on `threadCreate`, so a fresh read after creation includes the new thread.
function makeGrowingStubOverrides(opts: {
	readonly newThreadId: string;
	readonly runId: string;
	readonly events: readonly RunEventValue[];
}): Partial<WsClientService> {
	const threads: { id: string; title: string; last_activity_at: number }[] = [];
	return {
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
		subscribeRun: () => Stream.fromIterable(opts.events),
	};
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
		const overrides = makeStubOverrides();
		const onOpenThread = vi.fn();

		renderWithCore(<Sidebar onOpenThread={onOpenThread} />, {
			overrides,
			path: "/",
		});

		const first = await screen.findByText("Standup digest");
		expect(await screen.findByText("API rename plan")).toBeInTheDocument();

		await user.click(first);

		// Thread focus is the URL (ADR-0061): the row asks its parent to navigate.
		expect(onOpenThread).toHaveBeenCalledWith("t-1");
	});

	it("marks the row matching the focused-thread route as current", async () => {
		const overrides = makeStubOverrides();

		// Mounted at /thread/t-2 → the "API rename plan" row is the current one.
		renderWithCore(<Sidebar />, { overrides, path: "/thread/t-2" });

		const current = await screen.findByRole("button", {
			name: "API rename plan",
		});
		expect(current).toHaveAttribute("aria-current", "true");
		const other = screen.getByRole("button", { name: "Standup digest" });
		expect(other).not.toHaveAttribute("aria-current");
	});

	it("keeps the New Chat button and fires its handler on click", async () => {
		const user = userEvent.setup();
		const overrides = makeStubOverrides();
		const onNewChat = vi.fn();

		renderWithCore(<Sidebar onNewChat={onNewChat} />, {
			overrides,
			path: "/thread/t-1",
		});

		await screen.findByText("Standup digest");
		await user.click(screen.getByRole("button", { name: /new chat/i }));
		expect(onNewChat).toHaveBeenCalledTimes(1);
	});

	it("shows a newly-created thread without a manual reload", async () => {
		const user = userEvent.setup();
		const overrides = makeGrowingStubOverrides({
			newThreadId: "thread-new",
			runId: "run-1",
			events: [{ kind: "text_delta", delta: "echo: hi" }, { kind: "done" }],
		});

		// Sidebar + ChatColumn share one runtime + router — the real app wiring. The
		// Sidebar's New Chat / open-thread navigations are unused here; the send path
		// drives ChatColumn, which invalidates ["threads"] so the sidebar re-reads.
		renderWithCore(
			<>
				<Sidebar />
				<ChatColumn />
			</>,
			{ overrides, path: "/" },
		);

		expect(await screen.findByText(/no threads yet/i)).toBeInTheDocument();

		await user.type(screen.getByRole("textbox", { name: /message/i }), "hi");
		await user.click(screen.getByRole("button", { name: /send/i }));

		// Sidebar surfaces the minted thread (title = prompt), proving thread/list was invalidated on create.
		expect(
			await screen.findByRole("button", { name: "hi" }),
		).toBeInTheDocument();
	});

	it("carries the documented focus-visible ring on its hand-rolled buttons", async () => {
		const overrides = makeStubOverrides();

		renderWithCore(<Sidebar />, { overrides, path: "/" });

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
	});

	it("copies a thread's id to the clipboard from its row button", async () => {
		const user = userEvent.setup();
		const overrides = makeStubOverrides();

		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});

		renderWithCore(<Sidebar />, { overrides, path: "/" });

		// Copy-id control writes the thread id (not its title) to the clipboard.
		const copyBtn = await screen.findByRole("button", {
			name: /copy thread id for standup digest/i,
		});
		await user.click(copyBtn);

		expect(writeText).toHaveBeenCalledWith("t-1");
	});

	it("confirms a successful copy with a 'Copied' affordance", async () => {
		const user = userEvent.setup();
		const overrides = makeStubOverrides();

		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn(() => Promise.resolve()) },
			configurable: true,
		});

		renderWithCore(<Sidebar />, { overrides, path: "/" });

		const copyBtn = await screen.findByRole("button", {
			name: /copy thread id for standup digest/i,
		});
		await user.click(copyBtn);

		// The button flips its title to "Copied" so the click has visible feedback
		// (only on a write that actually resolved — never a fake success).
		await waitFor(() => expect(copyBtn).toHaveAttribute("title", "Copied"));
	});

	it("shows 'Couldn't copy' (never a fake checkmark) when the clipboard write fails", async () => {
		const user = userEvent.setup();
		const overrides = makeStubOverrides();

		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) },
			configurable: true,
		});

		renderWithCore(<Sidebar />, { overrides, path: "/" });

		const copyBtn = await screen.findByRole("button", {
			name: /copy thread id for standup digest/i,
		});
		await user.click(copyBtn);

		await waitFor(() =>
			expect(copyBtn).toHaveAttribute("title", "Couldn't copy"),
		);
		expect(copyBtn).not.toHaveAttribute("title", "Copied");
	});

	it("inline rename commits on Enter and cancels on Escape", async () => {
		const user = userEvent.setup();
		const { overrides, threadRename } = makeRecordingOverrides();

		renderWithCore(<Sidebar />, { overrides, path: "/" });

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
	});

	it("inline rename is a no-op on an empty title", async () => {
		const user = userEvent.setup();
		const { overrides, threadRename } = makeRecordingOverrides();

		renderWithCore(<Sidebar />, { overrides, path: "/" });

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
	});

	it("inline rename is a no-op on a whitespace-only title", async () => {
		const user = userEvent.setup();
		const { overrides, threadRename } = makeRecordingOverrides();

		renderWithCore(<Sidebar />, { overrides, path: "/" });

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
	});

	it("inline rename is a no-op when the title is unchanged", async () => {
		const user = userEvent.setup();
		const { overrides, threadRename } = makeRecordingOverrides();

		renderWithCore(<Sidebar />, { overrides, path: "/" });

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
	});

	it("inline rename commits on blur", async () => {
		const user = userEvent.setup();
		const { overrides, threadRename } = makeRecordingOverrides();

		renderWithCore(<Sidebar />, { overrides, path: "/" });

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
	});

	it("surfaces a failed rename inline and keeps the typed title editable", async () => {
		const user = userEvent.setup();
		const overrides = makeFailingRenameOverrides();

		renderWithCore(<Sidebar />, { overrides, path: "/" });

		await user.dblClick(
			await screen.findByRole("button", { name: "Standup digest" }),
		);
		const input = screen.getByRole("textbox", { name: /rename thread/i });
		await user.clear(input);
		await user.type(input, "Daily standup{Enter}");

		// The rename failed: an inline alert appears, and the input STAYS open with
		// the typed title intact (never silently discarded back to the old title).
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/couldn't rename/i,
		);
		expect(screen.getByRole("textbox", { name: /rename thread/i })).toHaveValue(
			"Daily standup",
		);
	});

	it("offers a keyboard-reachable rename affordance (not double-click only)", async () => {
		const user = userEvent.setup();
		const { overrides } = makeRecordingOverrides();

		renderWithCore(<Sidebar />, { overrides, path: "/" });

		await screen.findByRole("button", { name: "Standup digest" });
		// A dedicated Rename button opens the editor without a double-click. Drive it
		// by KEYBOARD (focus + Enter), not a click, so the test actually proves the
		// keyboard path the affordance exists for (ADR-0052 a11y).
		const renameButton = screen.getByRole("button", {
			name: "Rename thread Standup digest",
		});
		renameButton.focus();
		expect(renameButton).toHaveFocus();
		await user.keyboard("{Enter}");
		expect(screen.getByRole("textbox", { name: /rename thread/i })).toHaveValue(
			"Standup digest",
		);
	});

	it("archiving the focused thread navigates to the welcome route", async () => {
		const user = userEvent.setup();
		const { overrides, threadArchive } = makeRecordingOverrides();
		const onNewChat = vi.fn();

		// Focused on t-1: archiving it must reselect via onNewChat (→ "/").
		renderWithCore(<Sidebar onNewChat={onNewChat} />, {
			overrides,
			path: "/thread/t-1",
		});

		await screen.findByText("Standup digest");
		await user.click(
			screen.getByRole("button", { name: "Archive thread Standup digest" }),
		);

		// The reselect fires on the mutation's SUCCESS, so await it.
		await waitFor(() => expect(threadArchive).toHaveBeenCalledWith("t-1"));
		await waitFor(() => expect(onNewChat).toHaveBeenCalledTimes(1));
	});

	it("the Archived nav row calls onOpenArchived", async () => {
		const user = userEvent.setup();
		const overrides = makeStubOverrides();
		const onOpenArchived = vi.fn();

		renderWithCore(<Sidebar onOpenArchived={onOpenArchived} />, {
			overrides,
			path: "/",
		});

		await user.click(
			await screen.findByRole("button", { name: /^archived$/i }),
		);
		expect(onOpenArchived).toHaveBeenCalledTimes(1);
	});

	it("archiving a non-focused thread does NOT navigate", async () => {
		const user = userEvent.setup();
		const { overrides, threadArchive } = makeRecordingOverrides();
		const onNewChat = vi.fn();

		// Focused on t-1; archive t-2 → no reselect.
		renderWithCore(<Sidebar onNewChat={onNewChat} />, {
			overrides,
			path: "/thread/t-1",
		});

		await screen.findByText("API rename plan");
		await user.click(
			screen.getByRole("button", { name: "Archive thread API rename plan" }),
		);

		await waitFor(() => expect(threadArchive).toHaveBeenCalledWith("t-2"));
		expect(onNewChat).not.toHaveBeenCalled();
	});
});
