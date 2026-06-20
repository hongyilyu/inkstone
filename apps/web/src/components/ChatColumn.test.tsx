import type { ThreadGetResult } from "@inkstone/protocol";
import {
	type RunEventValue,
	UnknownThreadError,
	WsClient,
	WsRequestError,
} from "@inkstone/ui-sdk";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Deferred, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBridge } from "@/store/bridge";
import {
	appendUserMessage,
	getChatState,
	resetChatStore,
	seedAssistantMessage,
	setPendingProposal,
} from "@/store/chat";
import { renderChatRoute } from "@/test-utils/renderChatRoute";
import { ChatColumn } from "./ChatColumn.js";

// Stub WsClient injected via RuntimeProvider (no real socket); its finite subscribeRun event list drives the store.
function makeStubRuntime(opts: {
	readonly runId: string;
	readonly events: readonly RunEventValue[];
	readonly threadId?: string;
	readonly cancelRun?: WsClient["Type"]["cancelRun"];
}) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () =>
			Effect.succeed({
				thread_id: opts.threadId ?? "thread-new",
				run_id: opts.runId,
			}),
		postMessage: () => Effect.succeed(opts.runId),
		threadList: () => unused,
		getRunHistory: () => unused,
		// Park hydrate-on-focus: a focused thread stays `loading` (these tests drive messages directly, not via thread/get).
		threadGet: () => Effect.never,
		listEntities: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => Stream.fromIterable(opts.events),
		cancelRun:
			opts.cancelRun ??
			(() => Effect.succeed({ outcome: "accepted" as const })),
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

/**
 * Mount ChatColumn focused on `threadId` (its route is `/thread/<id>`, ADR-0042).
 * `focusedMessageId` appends the `?focusedMessageId=` deep-link search param.
 */
function renderFocused(
	runtime: ReturnType<typeof makeStubRuntime>,
	threadId: string,
	opts: { queryClient?: QueryClient; focusedMessageId?: string } = {},
) {
	const query = opts.focusedMessageId
		? `?focusedMessageId=${opts.focusedMessageId}`
		: "";
	return renderChatRoute(<ChatColumn />, {
		runtime,
		path: `/thread/${threadId}${query}`,
		queryClient: opts.queryClient,
	});
}

// All renders are async (the helper awaits the router's initial load). Tests that
// were synchronous before now `await renderFocused(...)` / `await renderChatRoute(...)`.

// jsdom ships no scrollIntoView; the search-jump tests stub it on the prototype.
// Capture the (undefined) original so afterEach can restore it and the stub can't
// leak into later tests in this file.
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
	resetChatStore();
	resetBridge();
});

afterEach(() => {
	cleanup();
	Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe("ChatColumn", () => {
	it("sends into the focused thread and streams an echo reply", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime({
			runId: "run-1",
			events: [{ kind: "text_delta", delta: "echo: hi" }, { kind: "done" }],
		});

		await renderFocused(runtime, "threadA");

		await user.type(screen.getByRole("textbox", { name: /message/i }), "hi");
		await user.click(screen.getByRole("button", { name: /send/i }));

		const userBubble = await screen.findByText("hi");
		expect(userBubble.closest('[data-role="user"]')).toBeInTheDocument();

		const assistantBubble = await screen.findByText("echo: hi");
		expect(
			assistantBubble.closest('[data-role="assistant"]'),
		).toBeInTheDocument();

		await runtime.dispose();
	});

	it("invalidates both the thread list and the recent-Runs feed on send", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime({
			runId: "run-inv",
			events: [{ kind: "text_delta", delta: "echo: hi" }, { kind: "done" }],
		});

		// A real QueryClient whose invalidateQueries we can observe: a send births/
		// advances a Run, so the right-rail feed (["run-history"]) must refresh
		// alongside the sidebar (["threads"]).
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const invalidated: unknown[] = [];
		const spy = vi
			.spyOn(client, "invalidateQueries")
			.mockImplementation((filters) => {
				invalidated.push(filters?.queryKey);
				return Promise.resolve();
			});

		await renderFocused(runtime, "threadA", { queryClient: client });

		await user.type(screen.getByRole("textbox", { name: /message/i }), "hi");
		await user.click(screen.getByRole("button", { name: /send/i }));

		await waitFor(() => {
			expect(invalidated).toContainEqual(["threads"]);
			expect(invalidated).toContainEqual(["run-history"]);
		});

		spy.mockRestore();
		await runtime.dispose();
	});

	it("blocks blank sends via the composer trim-guard", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime({
			runId: "run-x",
			events: [{ kind: "done" }],
		});

		await renderFocused(runtime, "threadA");

		await user.type(screen.getByRole("textbox", { name: /message/i }), "   ");
		await user.click(screen.getByRole("button", { name: /send/i }));

		expect(getChatState().threads.threadA?.messages ?? []).toHaveLength(0);

		await runtime.dispose();
	});

	it("welcomes the user on the / route (no thread focused) with no messages", async () => {
		const runtime = makeStubRuntime({ runId: "run-welcome", events: [] });

		await renderChatRoute(<ChatColumn />, { runtime, path: "/" });

		expect(
			screen.getByRole("heading", { name: /start a chat/i }),
		).toBeInTheDocument();
		expect(screen.getByText(/land in your library/i)).toBeInTheDocument();

		await runtime.dispose();
	});

	it("shows a loading skeleton while a focused thread hydrates", async () => {
		const runtime = makeStubRuntime({ runId: "run-hydrate", events: [] });

		await renderFocused(runtime, "threadA");

		expect(
			screen.getByRole("status", { name: /loading conversation/i }),
		).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: /start a chat/i })).toBeNull();

		await runtime.dispose();
	});

	it("shows a recoverable error (not an eternal skeleton) when hydration fails, and recovers on retry", async () => {
		const user = userEvent.setup();
		// First thread/get fails; the retry succeeds with a one-message history.
		const history: ThreadGetResult = {
			thread_id: "threadA",
			title: "T",
			messages: [
				{
					id: "m1",
					role: "assistant",
					status: "completed",
					run_id: "r1",
					segments: [{ kind: "text", text: "recovered history" }],
				},
			],
		};
		let calls = 0;
		const unused = Effect.die("not exercised in this test");
		const stub = WsClient.of({
			threadCreate: () => unused,
			postMessage: () => unused,
			threadList: () => unused,
			getRunHistory: () => unused,
			threadGet: () => {
				calls += 1;
				return calls === 1
					? Effect.fail(new WsRequestError({ reason: "boom" }))
					: Effect.succeed(history);
			},
			listEntities: () => unused,
			entityMutate: () => unused,
			subscribeRun: () => Stream.empty,
			cancelRun: () => unused,
			providerStatus: () => unused,
			providerLoginStart: () => unused,
			modelCatalog: () => unused,
			settingsGet: () => unused,
			settingsSet: () => unused,
			proposalGet: () => unused,
			proposalDecide: () => unused,
			messageSearch: () => unused,
			proposalNotifications: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));

		await renderFocused(runtime, "threadA");

		// The failed fetch resolves to a recoverable error, never the spinning skeleton.
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/couldn't load this conversation/i);
		expect(
			screen.queryByRole("status", { name: /loading conversation/i }),
		).toBeNull();

		await user.click(screen.getByRole("button", { name: /try again/i }));

		// Retry succeeds → history renders, error gone.
		expect(await screen.findByText("recovered history")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load this conversation/i)).toBeNull();

		await runtime.dispose();
	});

	it("shows an honest not-found state (with a Back-to-New-Chat exit, no retry) for a missing thread", async () => {
		const user = userEvent.setup();
		const unused = Effect.die("not exercised in this test");
		const stub = WsClient.of({
			threadCreate: () => unused,
			postMessage: () => unused,
			threadList: () => unused,
			getRunHistory: () => unused,
			threadGet: () =>
				Effect.fail(new UnknownThreadError({ message: "no such thread" })),
			listEntities: () => unused,
			entityMutate: () => unused,
			subscribeRun: () => Stream.empty,
			cancelRun: () => unused,
			providerStatus: () => unused,
			providerLoginStart: () => unused,
			modelCatalog: () => unused,
			settingsGet: () => unused,
			settingsSet: () => unused,
			proposalGet: () => unused,
			proposalDecide: () => unused,
			messageSearch: () => unused,
			proposalNotifications: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));

		const { router } = await renderChatRoute(<ChatColumn />, {
			runtime,
			path: "/thread/does-not-exist",
		});

		// The not-found card shows; the recoverable retry affordance does NOT.
		expect(
			await screen.findByText(/this thread isn't available/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
		expect(
			screen.queryByRole("status", { name: /loading conversation/i }),
		).toBeNull();

		// The exit routes back to the welcome surface.
		await user.click(screen.getByRole("button", { name: /back to new chat/i }));
		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/");
		});

		await runtime.dispose();
	});

	it("mints a new thread on the first send from / and navigates to its route", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime({
			runId: "run-2",
			threadId: "thread-new",
			events: [{ kind: "text_delta", delta: "echo: hello" }, { kind: "done" }],
		});

		const { router } = await renderChatRoute(<ChatColumn />, {
			runtime,
			path: "/",
		});

		await user.type(screen.getByRole("textbox", { name: /message/i }), "hello");
		await user.click(screen.getByRole("button", { name: /send/i }));

		const userBubble = await screen.findByText("hello");
		expect(userBubble.closest('[data-role="user"]')).toBeInTheDocument();

		const assistantBubble = await screen.findByText("echo: hello");
		expect(
			assistantBubble.closest('[data-role="assistant"]'),
		).toBeInTheDocument();

		// Mint-on-send navigates to the new thread's URL (ADR-0042) — focus is the route.
		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/thread/thread-new");
		});

		await runtime.dispose();
	});

	it("shows a typing indicator for a streaming assistant message with no text", async () => {
		const runtime = makeStubRuntime({ runId: "run-3", events: [] });
		seedAssistantMessage("threadA", {
			id: "a1",
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "r1",
		});

		await renderFocused(runtime, "threadA");

		expect(screen.getByTestId("typing-indicator")).toBeInTheDocument();
	});

	it("hides the typing indicator once streamed text arrives", async () => {
		const runtime = makeStubRuntime({ runId: "run-4", events: [] });
		seedAssistantMessage("threadA", {
			id: "a2",
			role: "assistant",
			status: "streaming",
			segments: [{ kind: "text", text: "hi" }],
			run_id: "r2",
		});

		await renderFocused(runtime, "threadA");

		expect(screen.queryByTestId("typing-indicator")).toBeNull();
	});

	it("copies the message text and swaps to the Check icon on a completed assistant message", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});

		const runtime = makeStubRuntime({ runId: "run-6", events: [] });
		seedAssistantMessage("threadA", {
			id: "a4",
			role: "assistant",
			status: "completed",
			segments: [{ kind: "text", text: "hello world" }],
			run_id: "r4",
		});

		await renderFocused(runtime, "threadA");

		const copyButton = screen.getByRole("button", { name: /copy/i });
		await user.click(copyButton);

		expect(writeText).toHaveBeenCalledWith("hello world");
		await waitFor(() => {
			expect(screen.getByTestId("copy-button-check")).toBeInTheDocument();
		});
	});

	it("renders a decided proposal's Applied indicator ABOVE the copy button", async () => {
		const runtime = makeStubRuntime({ runId: "run-applied", events: [] });
		seedAssistantMessage("threadA", {
			id: "a-applied",
			role: "assistant",
			status: "completed",
			segments: [{ kind: "text", text: "Logged." }],
			run_id: "r-applied",
		});
		// An accepted apply_intent_graph proposal renders the "Applied." card.
		setPendingProposal({
			proposal_id: "p-applied",
			run_id: "r-applied",
			mutation_kind: "apply_intent_graph",
			payload: null,
			rationale: null,
			status: "accepted",
		});

		await renderFocused(runtime, "threadA");

		const appliedCard = screen.getByText("Applied.");
		const copyButton = screen.getByRole("button", { name: /copy/i });
		// DOCUMENT_POSITION_FOLLOWING (4) ⇒ the copy button follows the card in DOM
		// order, i.e. the Applied indicator sits ABOVE the copy affordance.
		expect(
			appliedCard.compareDocumentPosition(copyButton) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders segments in timeline order: tool row, THEN proposal, THEN text (ADR-0045)", async () => {
		const runtime = makeStubRuntime({ runId: "run-order", events: [] });
		// A turn whose timeline is tool_call → proposal → text. The hardcoded bubble
		// always put text before the proposal; segment-ordered render must honor this.
		seedAssistantMessage("threadA", {
			id: "a-order",
			role: "assistant",
			status: "completed",
			run_id: "r-order",
			segments: [
				{
					kind: "tool_call",
					call: { id: "tc", name: "search_entities", status: "completed" },
				},
				{ kind: "proposal", runId: "r-order" },
				{ kind: "text", text: "the reply text" },
			],
		});
		setPendingProposal({
			proposal_id: "p-order",
			run_id: "r-order",
			mutation_kind: "apply_intent_graph",
			payload: null,
			rationale: null,
			status: "accepted",
		});

		await renderFocused(runtime, "threadA");

		const toolRow = screen.getByTestId("tool-call");
		const proposal = document.querySelector('[data-proposal="r-order"]');
		const text = screen.getByText("the reply text");
		expect(proposal).not.toBeNull();
		// tool row precedes proposal, proposal precedes text (DOCUMENT_POSITION_FOLLOWING = 4).
		expect(
			toolRow.compareDocumentPosition(proposal as Node) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			(proposal as Node).compareDocumentPosition(text) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("shows no copy button on a streaming assistant message", async () => {
		const runtime = makeStubRuntime({ runId: "run-7", events: [] });
		seedAssistantMessage("threadA", {
			id: "a5",
			role: "assistant",
			status: "streaming",
			segments: [{ kind: "text", text: "partial response" }],
			run_id: "r5",
		});

		await renderFocused(runtime, "threadA");

		expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
	});

	it("shows no copy button on an empty completed assistant message", async () => {
		const runtime = makeStubRuntime({ runId: "run-8", events: [] });
		seedAssistantMessage("threadA", {
			id: "a6",
			role: "assistant",
			status: "completed",
			segments: [],
			run_id: "r6",
		});

		await renderFocused(runtime, "threadA");

		expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
	});

	it("shows no typing indicator on a completed (empty) assistant message", async () => {
		const runtime = makeStubRuntime({ runId: "run-5", events: [] });
		seedAssistantMessage("threadA", {
			id: "a3",
			role: "assistant",
			status: "completed",
			segments: [],
			run_id: "r3",
		});

		await renderFocused(runtime, "threadA");

		expect(screen.queryByTestId("typing-indicator")).toBeNull();
	});

	it("renders a running tool call with its label and suppresses the typing dots", async () => {
		const runtime = makeStubRuntime({ runId: "run-tc1", events: [] });
		seedAssistantMessage("threadA", {
			id: "a7",
			role: "assistant",
			status: "streaming",
			run_id: "r7",
			segments: [
				{
					kind: "tool_call",
					call: { id: "tc_1", name: "read_thread", status: "running" },
				},
			],
		});

		await renderFocused(runtime, "threadA");

		const row = screen.getByTestId("tool-call");
		expect(row).toHaveAttribute("data-status", "running");
		expect(row).toHaveTextContent("Reading this thread");
		expect(row).toHaveTextContent(/read-only/i);
		// A running tool row is the activity signal; the typing dots must not double up.
		expect(screen.queryByTestId("typing-indicator")).toBeNull();
	});

	it("renders a completed tool call in its settled past-tense state", async () => {
		const runtime = makeStubRuntime({ runId: "run-tc2", events: [] });
		seedAssistantMessage("threadA", {
			id: "a8",
			role: "assistant",
			status: "completed",
			run_id: "r8",
			segments: [
				{
					kind: "tool_call",
					call: { id: "tc_2", name: "read_thread", status: "completed" },
				},
				{ kind: "text", text: "done" },
			],
		});

		await renderFocused(runtime, "threadA");

		const row = screen.getByTestId("tool-call");
		expect(row).toHaveAttribute("data-status", "completed");
		expect(row).toHaveTextContent("Read this thread");
	});

	it("surfaces an errored tool call with a failed indication", async () => {
		const runtime = makeStubRuntime({ runId: "run-tc3", events: [] });
		seedAssistantMessage("threadA", {
			id: "a9",
			role: "assistant",
			status: "streaming",
			run_id: "r9",
			segments: [
				{
					kind: "tool_call",
					call: { id: "tc_3", name: "read_thread", status: "error" },
				},
			],
		});

		await renderFocused(runtime, "threadA");

		const row = screen.getByTestId("tool-call");
		expect(row).toHaveAttribute("data-status", "error");
		expect(row).toHaveTextContent(/failed/i);
	});

	it("falls back to a humanized label for an unregistered tool", async () => {
		const runtime = makeStubRuntime({ runId: "run-tc4", events: [] });
		seedAssistantMessage("threadA", {
			id: "a10",
			role: "assistant",
			status: "streaming",
			run_id: "r10",
			segments: [
				{
					kind: "tool_call",
					call: { id: "tc_4", name: "search_web", status: "running" },
				},
			],
		});

		await renderFocused(runtime, "threadA");

		expect(screen.getByTestId("tool-call")).toHaveTextContent("Search web");
	});

	it("renders a search_entities row with its display arg (ADR-0043)", async () => {
		const runtime = makeStubRuntime({ runId: "run-tc5", events: [] });
		seedAssistantMessage("threadA", {
			id: "a11",
			role: "assistant",
			status: "completed",
			run_id: "r11",
			segments: [
				{
					kind: "tool_call",
					call: {
						id: "tc_5",
						name: "search_entities",
						status: "completed",
						arg: "Lev",
					},
				},
				{ kind: "text", text: "done" },
			],
		});

		await renderFocused(runtime, "threadA");

		const row = screen.getByTestId("tool-call");
		expect(row).toHaveTextContent("Searched entities");
		expect(row).toHaveTextContent("· Lev");
	});

	it("shows a Stop control while a run streams and settles the bubble on cancel", async () => {
		const user = userEvent.setup();
		const cancelRun = vi.fn(() =>
			Effect.succeed({ outcome: "accepted" as const }),
		);
		// A partial (non-terminal) stream: the assistant turn stays active (no
		// done/error/cancelled), so activeRunId stays set and Stop is shown.
		const runtime = makeStubRuntime({
			runId: "run-stop",
			threadId: "thread-stop",
			events: [{ kind: "text_delta", delta: "echo: h" }],
			cancelRun,
		});

		await renderFocused(runtime, "threadA");

		await user.type(screen.getByRole("textbox", { name: /message/i }), "hi");
		await user.click(screen.getByRole("button", { name: /send/i }));

		// Partial text rendered and the run is active → Send becomes Stop.
		await screen.findByText("echo: h");
		const stop = await screen.findByRole("button", { name: /stop/i });

		await user.click(stop);

		// Cancel reached Core and the bubble settled to the cancelled/incomplete state.
		expect(cancelRun).toHaveBeenCalledWith("run-stop");
		await screen.findByTestId("assistant-error");
		// Stop is gone (run no longer active) and Send is back.
		await waitFor(() => {
			expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
		});
		expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();

		await runtime.dispose();
	});

	it("scrolls to and highlights the message matching the search-jump anchor", async () => {
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		const runtime = makeStubRuntime({ runId: "run-jump", events: [] });
		appendUserMessage("threadA", {
			id: "u-top",
			role: "user",
			status: "completed",
			segments: [{ kind: "text", text: "first message" }],
			run_id: "",
		});
		seedAssistantMessage("threadA", {
			id: "a-deep",
			role: "assistant",
			status: "completed",
			segments: [
				{ kind: "text", text: "the matched reply deep in scrollback" },
			],
			run_id: "r-deep",
		});

		// A ⌘K hit deep-linked to the message via ?focusedMessageId= (ADR-0042).
		const { router } = await renderFocused(runtime, "threadA", {
			focusedMessageId: "a-deep",
		});

		const target = await screen.findByText(
			"the matched reply deep in scrollback",
		);
		const li = target.closest("li");
		// The anchored row is scrolled into view, centered, with a reduced-motion-safe
		// instant jump (behavior: "auto", never a glide).
		await waitFor(() => {
			expect(scrollIntoView).toHaveBeenCalledWith({
				block: "center",
				behavior: "auto",
			});
		});
		expect(li).toHaveAttribute("data-message-id", "a-deep");
		// The matched content box wears the lamplight ring…
		expect(li?.querySelector("[data-highlighted]")).not.toBeNull();
		// …and the URL anchor is stripped (consume-then-strip) so a reload/re-render
		// can't re-fire it, while the path stays on the thread.
		await waitFor(() => {
			expect(router.state.location.search).toEqual({});
		});
		expect(router.state.location.pathname).toBe("/thread/threadA");

		await runtime.dispose();
	});

	it("jumps to the anchor exactly once even as later messages arrive (streaming) before the strip commits", async () => {
		// The URL strip is async, so focusedMessageId lingers a few renders. A later
		// `messages` change in that window (e.g. a live Run's text_delta on the
		// deep-linked thread) must NOT re-fire the jump and yank the viewport — the
		// per-anchor one-shot guard makes it fire exactly once (deep-review finding).
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		const runtime = makeStubRuntime({ runId: "run-once", events: [] });
		appendUserMessage("threadA", {
			id: "u-top",
			role: "user",
			status: "completed",
			segments: [{ kind: "text", text: "first" }],
			run_id: "",
		});
		seedAssistantMessage("threadA", {
			id: "a-anchor",
			role: "assistant",
			status: "completed",
			segments: [{ kind: "text", text: "the anchored reply" }],
			run_id: "r-anchor",
		});

		await renderFocused(runtime, "threadA", { focusedMessageId: "a-anchor" });

		await screen.findByText("the anchored reply");
		await waitFor(() => {
			expect(scrollIntoView).toHaveBeenCalledTimes(1);
		});

		// Simulate a streaming delta arriving AFTER the jump: a new message mutates
		// the list (a new array ref), re-running the anchor effect while the async
		// strip may still be in flight. The anchor is still present in the list.
		await act(async () => {
			appendUserMessage("threadA", {
				id: "u-later",
				role: "user",
				status: "completed",
				segments: [{ kind: "text", text: "a later turn" }],
				run_id: "",
			});
			await Promise.resolve();
		});
		await screen.findByText("a later turn");

		// Still exactly one scroll — the one-shot guard held.
		expect(scrollIntoView).toHaveBeenCalledTimes(1);

		await runtime.dispose();
	});

	it("does not highlight any message when no search-jump anchor is set", async () => {
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		const runtime = makeStubRuntime({ runId: "run-noanchor", events: [] });
		seedAssistantMessage("threadA", {
			id: "a-plain",
			role: "assistant",
			status: "completed",
			segments: [{ kind: "text", text: "an ordinary reply" }],
			run_id: "r-plain",
		});

		const { container } = await renderFocused(runtime, "threadA");

		await screen.findByText("an ordinary reply");
		expect(scrollIntoView).not.toHaveBeenCalled();
		expect(container.querySelector("[data-highlighted]")).toBeNull();

		await runtime.dispose();
	});

	it("clears the search-jump highlight after its dwell so the ring is transient", async () => {
		Element.prototype.scrollIntoView = vi.fn();
		vi.useFakeTimers();
		try {
			const runtime = makeStubRuntime({ runId: "run-fade", events: [] });
			seedAssistantMessage("threadA", {
				id: "a-fade",
				role: "assistant",
				status: "completed",
				segments: [{ kind: "text", text: "the briefly-ringed reply" }],
				run_id: "r-fade",
			});

			const { container } = await renderFocused(runtime, "threadA", {
				focusedMessageId: "a-fade",
			});

			// The ring blooms on the (synchronously-flushed) scroll effect…
			expect(container.querySelector("[data-highlighted]")).not.toBeNull();
			// …holds just before the dwell elapses…
			act(() => {
				vi.advanceTimersByTime(1599);
			});
			expect(container.querySelector("[data-highlighted]")).not.toBeNull();
			// …then clears, so a stuck/permanent ring is a real regression this catches.
			act(() => {
				vi.advanceTimersByTime(1);
			});
			expect(container.querySelector("[data-highlighted]")).toBeNull();

			await runtime.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("scrolls to the bottom on cold-load when no anchor is set (ADR-0042)", async () => {
		// jsdom has no layout, so stub a non-zero scrollHeight and capture scrollTop
		// writes — the cold-load effect pins scrollTop to scrollHeight.
		const setScrollTop = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
			configurable: true,
			get: () => 4000,
		});
		const scrollTopSpy = vi
			.spyOn(HTMLElement.prototype, "scrollTop", "set")
			.mockImplementation(setScrollTop);
		try {
			const runtime = makeStubRuntime({ runId: "run-cold", events: [] });
			// A multi-message thread already present (simulates post-hydration).
			appendUserMessage("threadA", {
				id: "u-early",
				role: "user",
				status: "completed",
				segments: [{ kind: "text", text: "first" }],
				run_id: "",
			});
			seedAssistantMessage("threadA", {
				id: "a-late",
				role: "assistant",
				status: "completed",
				segments: [{ kind: "text", text: "last reply" }],
				run_id: "r-late",
			});

			await renderFocused(runtime, "threadA");

			await screen.findByText("last reply");
			// Pinned to the bottom: scrollTop set to the (stubbed) scrollHeight.
			await waitFor(() => {
				expect(setScrollTop).toHaveBeenCalledWith(4000);
			});

			await runtime.dispose();
		} finally {
			scrollTopSpy.mockRestore();
			delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
		}
	});

	it("does NOT bottom-scroll when an anchor is set — the anchor jump wins", async () => {
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		const setScrollTop = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
			configurable: true,
			get: () => 4000,
		});
		const scrollTopSpy = vi
			.spyOn(HTMLElement.prototype, "scrollTop", "set")
			.mockImplementation(setScrollTop);
		try {
			const runtime = makeStubRuntime({ runId: "run-anchor-wins", events: [] });
			appendUserMessage("threadA", {
				id: "u-early",
				role: "user",
				status: "completed",
				segments: [{ kind: "text", text: "first" }],
				run_id: "",
			});
			seedAssistantMessage("threadA", {
				id: "a-target",
				role: "assistant",
				status: "completed",
				segments: [{ kind: "text", text: "the anchored reply" }],
				run_id: "r-target",
			});

			await renderFocused(runtime, "threadA", { focusedMessageId: "a-target" });

			await screen.findByText("the anchored reply");
			// The anchor jump ran (scrollIntoView), and the bottom-scroll did NOT
			// fight it (scrollTop never pinned to scrollHeight).
			await waitFor(() => {
				expect(scrollIntoView).toHaveBeenCalledWith({
					block: "center",
					behavior: "auto",
				});
			});
			expect(setScrollTop).not.toHaveBeenCalledWith(4000);

			await runtime.dispose();
		} finally {
			scrollTopSpy.mockRestore();
			delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
		}
	});

	it("bottom-scrolls a GENUINELY cold thread once thread/get hydrates (not just the warm pre-seeded path)", async () => {
		// The other scroll tests pre-seed messages before render (warm path). This
		// one renders an EMPTY thread with a gated thread/get, then resolves it — so
		// the bottom-scroll must RE-FIRE after async hydration injects messages
		// post-mount. A mount-only or messages-less-dep regression fails here.
		const setScrollTop = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
			configurable: true,
			get: () => 4000,
		});
		const scrollTopSpy = vi
			.spyOn(HTMLElement.prototype, "scrollTop", "set")
			.mockImplementation(setScrollTop);
		const gate = Effect.runSync(Deferred.make<ThreadGetResult, never>());
		const history: ThreadGetResult = {
			thread_id: "threadCold",
			title: "T",
			messages: [
				{
					id: "m1",
					role: "user",
					status: "completed",
					run_id: "r1",
					segments: [{ kind: "text", text: "q" }],
				},
				{
					id: "m2",
					role: "assistant",
					status: "completed",
					run_id: "r1",
					segments: [{ kind: "text", text: "cold-hydrated reply" }],
				},
			],
		};
		const unused = Effect.die("not exercised in this test");
		const stub = WsClient.of({
			threadCreate: () => unused,
			postMessage: () => unused,
			threadList: () => unused,
			getRunHistory: () => unused,
			threadGet: () => Deferred.await(gate),
			listEntities: () => unused,
			entityMutate: () => unused,
			subscribeRun: () => Stream.empty,
			cancelRun: () => unused,
			providerStatus: () => unused,
			providerLoginStart: () => unused,
			modelCatalog: () => unused,
			settingsGet: () => unused,
			settingsSet: () => unused,
			proposalGet: () => unused,
			proposalDecide: () => unused,
			messageSearch: () => unused,
			proposalNotifications: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		try {
			// Empty store + pending thread/get → the skeleton, no messages yet.
			await renderFocused(runtime, "threadCold");
			expect(
				screen.getByRole("status", { name: /loading conversation/i }),
			).toBeInTheDocument();
			expect(setScrollTop).not.toHaveBeenCalledWith(4000);

			// Resolve hydration: messages arrive post-mount, the effect re-fires.
			await act(async () => {
				Effect.runSync(Deferred.succeed(gate, history));
				await Promise.resolve();
			});

			await screen.findByText("cold-hydrated reply");
			await waitFor(() => {
				expect(setScrollTop).toHaveBeenCalledWith(4000);
			});

			await runtime.dispose();
		} finally {
			scrollTopSpy.mockRestore();
			delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
		}
	});

	it("strips an unresolvable anchor and falls back to the bottom once messages are present", async () => {
		// A present-but-unmatched ?focusedMessageId (stale/deleted/typo'd id, or a
		// server-id anchor against a warm thread's client-minted ids): the anchor is
		// unresolvable. It must NOT linger in the URL forever or wedge the cold-load
		// bottom-scroll — strip it and pin to the bottom (the deep-review regression).
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		const setScrollTop = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
			configurable: true,
			get: () => 4000,
		});
		const scrollTopSpy = vi
			.spyOn(HTMLElement.prototype, "scrollTop", "set")
			.mockImplementation(setScrollTop);
		try {
			const runtime = makeStubRuntime({
				runId: "run-ghost-anchor",
				events: [],
			});
			// The thread is present (warm), but none of its ids is "ghost-id".
			appendUserMessage("threadA", {
				id: "u-early",
				role: "user",
				status: "completed",
				segments: [{ kind: "text", text: "first" }],
				run_id: "",
			});
			seedAssistantMessage("threadA", {
				id: "a-real",
				role: "assistant",
				status: "completed",
				segments: [{ kind: "text", text: "the only reply" }],
				run_id: "r-real",
			});

			const { router } = await renderFocused(runtime, "threadA", {
				focusedMessageId: "ghost-id",
			});

			await screen.findByText("the only reply");
			// The dead anchor is stripped from the URL (not left to linger/reload-loop).
			await waitFor(() => {
				expect(router.state.location.search).toEqual({});
			});
			// No row was highlighted (nothing to land on), and the bottom-scroll fired.
			expect(scrollIntoView).not.toHaveBeenCalled();
			await waitFor(() => {
				expect(setScrollTop).toHaveBeenCalledWith(4000);
			});

			await runtime.dispose();
		} finally {
			scrollTopSpy.mockRestore();
			delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
		}
	});

	it("offers Try again on an interrupted reply and re-sends the previous turn", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime({
			runId: "run-retry",
			events: [{ kind: "text_delta", delta: "recovered" }, { kind: "done" }],
		});
		appendUserMessage("threadA", {
			id: "u1",
			role: "user",
			status: "completed",
			segments: [{ kind: "text", text: "do it" }],
			run_id: "",
		});
		seedAssistantMessage("threadA", {
			id: "a-fail",
			role: "assistant",
			status: "incomplete",
			segments: [],
			run_id: "r-fail",
		});

		await renderFocused(runtime, "threadA");

		expect(screen.getByTestId("assistant-error")).toHaveTextContent(
			/nothing was saved without your approval/i,
		);

		await user.click(screen.getByRole("button", { name: /try again/i }));

		expect(await screen.findByText("recovered")).toBeInTheDocument();

		await runtime.dispose();
	});
});
