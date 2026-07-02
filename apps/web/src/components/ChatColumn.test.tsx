import type { ProviderStatusResult, ThreadGetResult } from "@inkstone/protocol";
import {
	type RunEventValue,
	stubWsClient,
	UnknownThreadError,
	WsClient,
	type WsError,
	WsRequestError,
} from "@inkstone/ui-sdk";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Deferred, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONNECTION_SEND_FAILURE,
	GENERIC_SEND_FAILURE,
} from "@/lib/connectionFailureCopy";
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
	readonly retryRun?: WsClient["Type"]["retryRun"];
	// When set, both the focused-thread send (`postMessage`) and the mint-on-send
	// (`threadCreate`) fail in the SDK's E channel with this WsError — so the real
	// bridge `send`/`sendNewThread` squash path surfaces it (slice 4).
	readonly sendFailure?: WsError;
	// ChatColumn now reads `provider/status` (slice 2) to gate the first-run connect
	// welcome. Default CONNECTED so the existing behaviour tests keep showing the
	// ordinary chat surface; the disconnected-welcome test opts out with `false`.
	readonly providerConnected?: boolean;
	// Override the whole provider/status read (e.g. `Effect.never` to hold it
	// pending) — wins over `providerConnected` when set.
	readonly providerStatus?: WsClient["Type"]["providerStatus"];
}) {
	const unused = Effect.die("not exercised in this test");
	const stub = stubWsClient({
		threadCreate: () =>
			opts.sendFailure
				? Effect.fail(opts.sendFailure)
				: Effect.succeed({
						thread_id: opts.threadId ?? "thread-new",
						run_id: opts.runId,
					}),
		postMessage: () =>
			opts.sendFailure
				? Effect.fail(opts.sendFailure)
				: Effect.succeed(opts.runId),
		// Park hydrate-on-focus: a focused thread stays `loading` (these tests drive messages directly, not via thread/get).
		threadGet: () => Effect.never,
		subscribeRun: () => Stream.fromIterable(opts.events),
		cancelRun:
			opts.cancelRun ??
			(() => Effect.succeed({ outcome: "accepted" as const })),
		// Fail fast on an UNEXPECTED retry path: a test that drives run/retry must
		// opt in via `opts.retryRun`; an accidental retry in an unrelated test dies
		// rather than silently passing on a default "accepted" (CodeRabbit #244).
		retryRun: opts.retryRun ?? (() => unused),
		providerStatus:
			opts.providerStatus ??
			(() =>
				Effect.succeed({
					providers: [
						{
							id: "openai-codex",
							connected: opts.providerConnected ?? true,
							auth_kind: "oauth",
						},
					],
				})),
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

/**
 * Mount ChatColumn focused on `threadId` (its route is `/thread/<id>`, ADR-0061).
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
		// Default-connected (a provider is wired) → the ordinary "Start a chat"
		// welcome, NOT the first-run connect screen (slice 2 gate is satisfied).
		const runtime = makeStubRuntime({ runId: "run-welcome", events: [] });

		await renderChatRoute(<ChatColumn />, { runtime, path: "/" });

		// No flash: the connect welcome is gated on a KNOWN-disconnected status, so
		// the in-flight read shows the ordinary "Start a chat" welcome immediately
		// (never the connect screen) for a connected install.
		expect(
			screen.getByRole("heading", { name: /start a chat/i }),
		).toBeInTheDocument();
		expect(screen.getByText(/land in your library/i)).toBeInTheDocument();
		// The connected welcome is NOT the first-run connect screen.
		expect(
			screen.queryByRole("heading", { name: /welcome to inkstone/i }),
		).toBeNull();

		await runtime.dispose();
	});

	it("shows the first-run connect welcome on / when NO provider is connected (deep-links to /settings/models)", async () => {
		// No provider wired yet → the branded connect screen replaces "Start a chat"
		// and its CTA deep-links to the Models settings page (slice 2).
		const runtime = makeStubRuntime({
			runId: "run-disconnected",
			events: [],
			providerConnected: false,
		});

		await renderChatRoute(<ChatColumn />, { runtime, path: "/" });

		// The branded connect heading shows…
		expect(
			await screen.findByRole("heading", { name: /welcome to inkstone/i }),
		).toBeInTheDocument();
		// …and the ordinary "Start a chat" welcome is gone.
		expect(screen.queryByRole("heading", { name: /start a chat/i })).toBeNull();

		// Exactly ONE "Connect a provider" link on `/`: the welcome CTA. The slice-3
		// in-thread hint (gated on `focusedThreadId !== null`) must NOT also render
		// here, so there is no second such link. This pins the hint's in-thread-only
		// gate directly, independent of the shared accessible name.
		const ctas = screen.getAllByRole("link", { name: /connect a provider/i });
		expect(ctas).toHaveLength(1);
		expect(ctas[0].getAttribute("href")).toContain("/settings/models");

		await runtime.dispose();
	});

	it("shows an in-thread connect hint and disables Send when no provider is connected", async () => {
		// A FOCUSED thread with a message already rendered (so the composer shows,
		// not the hydrating skeleton) but NO provider wired: the composer's Send is
		// soft-disabled and a slim in-thread "Connect a provider" hint sits above it,
		// deep-linking to the Models settings page (slice 3).
		const runtime = makeStubRuntime({
			runId: "run-gated",
			events: [],
			providerConnected: false,
		});
		seedAssistantMessage("threadA", {
			id: "a-gated",
			role: "assistant",
			status: "completed",
			segments: [{ kind: "text", text: "an earlier reply" }],
			run_id: "r-gated",
		});

		await renderFocused(runtime, "threadA");

		// The thread renders (not the skeleton)…
		await screen.findByText("an earlier reply");
		// …and once the (async) provider/status read settles disconnected, the slim
		// connect hint appears as a real navigable link to the Models settings page.
		const hint = await screen.findByRole("link", {
			name: /connect a provider/i,
		});
		expect(hint.getAttribute("href")).toContain("/settings/models");

		// Send is gated while disconnected.
		expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();

		await runtime.dispose();
	});

	it("does NOT show the in-thread connect hint and keeps Send enabled when a provider is connected", async () => {
		// Same focused-thread setup but default-CONNECTED: no in-thread hint, and
		// Send works as usual (slice 3 gate is satisfied).
		const runtime = makeStubRuntime({ runId: "run-connected", events: [] });
		seedAssistantMessage("threadA", {
			id: "a-connected",
			role: "assistant",
			status: "completed",
			segments: [{ kind: "text", text: "an earlier reply" }],
			run_id: "r-connected",
		});

		await renderFocused(runtime, "threadA");

		await screen.findByText("an earlier reply");
		// No connect hint, and Send is enabled.
		expect(
			screen.queryByRole("link", { name: /connect a provider/i }),
		).toBeNull();
		expect(screen.getByRole("button", { name: /send/i })).toBeEnabled();

		await runtime.dispose();
	});

	it("does NOT flash the connect welcome while provider status is still loading", async () => {
		// The connect screen is gated on a KNOWN status: until `provider/status`
		// resolves we show the neutral "Start a chat" welcome, never the connect
		// screen. With the read held pending forever, the connect heading must never
		// appear (it would, on every remount, if the gate read the bare anyConnected).
		const runtime = makeStubRuntime({
			runId: "run-pending",
			events: [],
			providerStatus: () => Effect.never,
		});

		await renderChatRoute(<ChatColumn />, { runtime, path: "/" });

		expect(
			screen.getByRole("heading", { name: /start a chat/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: /welcome to inkstone/i }),
		).toBeNull();

		await runtime.dispose();
	});

	it("serves the ordinary welcome synchronously from a pre-populated connected cache (no flash on a warm second visit)", async () => {
		// The CHAT side of the stale-cache flash fix: on a second visit to `/`,
		// ChatColumn remounts and — with staleTime:0 + refetchOnMount — refetches,
		// but TanStack serves the CACHED ["provider-status"] value synchronously on
		// the first render. This pins that a connected cache yields the ordinary
		// "Start a chat" welcome on that first paint, never the connect screen. The
		// companion guard that the connect actually WRITES connected into the cache
		// (setQueryData, not a no-op invalidate of the then-inactive query) lives in
		// routes/settings/models.page.test.tsx and is the test that breaks if the fix
		// is reverted.
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			},
		});
		client.setQueryData<ProviderStatusResult>(["provider-status"], {
			providers: [{ id: "openai-codex", connected: true, auth_kind: "oauth" }],
		});
		const runtime = makeStubRuntime({
			runId: "run-secondvisit",
			events: [],
			providerConnected: true,
		});

		await renderChatRoute(<ChatColumn />, {
			runtime,
			path: "/",
			queryClient: client,
		});

		// Connected cache → ordinary welcome on the first synchronous paint, never the
		// connect screen.
		expect(
			screen.getByRole("heading", { name: /start a chat/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: /welcome to inkstone/i }),
		).toBeNull();

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
		const stub = stubWsClient({
			threadGet: () => {
				calls += 1;
				return calls === 1
					? Effect.fail(new WsRequestError({ reason: "boom" }))
					: Effect.succeed(history);
			},
			// Default these full-stub behaviour tests to a CONNECTED provider so the
			// ordinary chat surface renders (slice 2's connect gate is off here).
			providerStatus: () =>
				Effect.succeed({
					providers: [
						{ id: "openai-codex", connected: true, auth_kind: "oauth" },
					],
				}),
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
		const stub = stubWsClient({
			threadGet: () =>
				Effect.fail(new UnknownThreadError({ message: "no such thread" })),
			// Default these full-stub behaviour tests to a CONNECTED provider so the
			// ordinary chat surface renders (slice 2's connect gate is off here).
			providerStatus: () =>
				Effect.succeed({
					providers: [
						{ id: "openai-codex", connected: true, auth_kind: "oauth" },
					],
				}),
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

		// Mint-on-send navigates to the new thread's URL (ADR-0061) — focus is the route.
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

	it("suppresses the typing indicator while a turn is parked on a Proposal", async () => {
		// A proposal-first (or tool→proposal) turn parks with no leading text but
		// KEEPS status "streaming" (only a terminal event flips it). The run is idle,
		// waiting on the user's decision — the "Assistant is typing" dots must not show.
		const runtime = makeStubRuntime({ runId: "run-parked", events: [] });
		seedAssistantMessage("threadA", {
			id: "a-parked",
			role: "assistant",
			status: "streaming",
			run_id: "r-parked",
			segments: [
				{
					kind: "tool_call",
					call: {
						id: "tc",
						name: "propose_workspace_mutation",
						status: "completed",
					},
				},
				{ kind: "proposal", runId: "r-parked" },
			],
		});
		setPendingProposal({
			proposal_id: "p-parked",
			run_id: "r-parked",
			mutation_kind: "create_todo",
			payload: { todo: { title: "Draft" } },
			rationale: null,
			status: "pending",
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

		// Cancel reached Core and the bubble settled to the calm "stopped" state —
		// NOT the destructive error alert (a deliberate Stop is not a failure, ADR-0014).
		expect(cancelRun).toHaveBeenCalledWith("run-stop");
		await screen.findByTestId("assistant-stopped");
		expect(screen.queryByTestId("assistant-error")).toBeNull();
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

		// A ⌘K hit deep-linked to the message via ?focusedMessageId= (ADR-0061).
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

	it("scrolls to the bottom on cold-load when no anchor is set (ADR-0061)", async () => {
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
		const stub = stubWsClient({
			threadGet: () => Deferred.await(gate),
			// Default these full-stub behaviour tests to a CONNECTED provider so the
			// ordinary chat surface renders (slice 2's connect gate is off here).
			providerStatus: () =>
				Effect.succeed({
					providers: [
						{ id: "openai-codex", connected: true, auth_kind: "oauth" },
					],
				}),
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

	it("renders a streaming reasoning segment as a collapsed 'Thinking…' disclosure with the trace hidden", async () => {
		const runtime = makeStubRuntime({ runId: "run-r1", events: [] });
		seedAssistantMessage("threadA", {
			id: "a-reason",
			role: "assistant",
			status: "streaming",
			run_id: "r-reason",
			segments: [{ kind: "reasoning", text: "hmm let me think" }],
		});

		await renderFocused(runtime, "threadA");

		// Collapsed by default while streaming (no auto-expand): the live label shows…
		const toggle = screen.getByRole("button", { name: /thinking/i });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		// …and the trace body is NOT visible.
		expect(screen.queryByText("hmm let me think")).toBeNull();

		await runtime.dispose();
	});

	it("expands the reasoning disclosure on click to reveal the trace", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime({ runId: "run-r2", events: [] });
		seedAssistantMessage("threadA", {
			id: "a-reason2",
			role: "assistant",
			status: "streaming",
			run_id: "r-reason2",
			segments: [{ kind: "reasoning", text: "hmm" }],
		});

		await renderFocused(runtime, "threadA");

		const toggle = screen.getByRole("button", { name: /thinking/i });
		expect(screen.queryByText("hmm")).toBeNull();

		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("hmm")).toBeInTheDocument();

		await runtime.dispose();
	});

	it("labels a sealed reasoning segment 'Thought for Ns' when durationMs >= 1000", async () => {
		const runtime = makeStubRuntime({ runId: "run-r3", events: [] });
		seedAssistantMessage("threadA", {
			id: "a-reason3",
			role: "assistant",
			status: "completed",
			run_id: "r-reason3",
			segments: [
				{ kind: "reasoning", text: "deep thoughts", durationMs: 4000 },
				{ kind: "text", text: "the reply" },
			],
		});

		await renderFocused(runtime, "threadA");

		expect(
			screen.getByRole("button", { name: /thought for 4s/i }),
		).toBeInTheDocument();

		await runtime.dispose();
	});

	it("labels a sealed reasoning segment bare 'Thought' when durationMs is undefined or sub-second", async () => {
		const runtime = makeStubRuntime({ runId: "run-r4", events: [] });
		seedAssistantMessage("threadA", {
			id: "a-reason4",
			role: "assistant",
			status: "completed",
			run_id: "r-reason4",
			segments: [
				{ kind: "reasoning", text: "a quick thought" },
				{ kind: "reasoning", text: "another", durationMs: 400 },
				{ kind: "text", text: "the reply" },
			],
		});

		await renderFocused(runtime, "threadA");

		// Both an undefined duration and a sub-second one read bare "Thought" (no "for Ns").
		const toggles = screen.getAllByRole("button", { name: /^thought$/i });
		expect(toggles).toHaveLength(2);
		expect(screen.queryByRole("button", { name: /thought for/i })).toBeNull();

		await runtime.dispose();
	});

	it("suppresses the typing indicator while ONLY a reasoning segment is streaming", async () => {
		const runtime = makeStubRuntime({ runId: "run-r5", events: [] });
		seedAssistantMessage("threadA", {
			id: "a-reason5",
			role: "assistant",
			status: "streaming",
			run_id: "r-reason5",
			// concatText === "" (no text segment) and no running tool — but a reasoning
			// segment is present, so the "Thinking…" disclosure stands in for the dots.
			segments: [{ kind: "reasoning", text: "thinking out loud" }],
		});

		await renderFocused(runtime, "threadA");

		expect(screen.queryByTestId("typing-indicator")).toBeNull();
		expect(
			screen.getByRole("button", { name: /thinking/i }),
		).toBeInTheDocument();

		await runtime.dispose();
	});

	it("shows 'Thought for Ns' (not 'Thinking…') for a SEALED reasoning block while the reply still streams", async () => {
		const runtime = makeStubRuntime({ runId: "run-r6", events: [] });
		seedAssistantMessage("threadA", {
			id: "a-reason6",
			role: "assistant",
			// Turn is still streaming (the reply text is arriving)…
			status: "streaming",
			run_id: "r-reason6",
			// …but the reasoning block already sealed (durationMs set when the text opened).
			// It must read the calm settled label, not a stale pulsing "Thinking…".
			segments: [
				{ kind: "reasoning", text: "decided", durationMs: 2000 },
				{ kind: "text", text: "Here it is" },
			],
		});

		await renderFocused(runtime, "threadA");

		expect(
			screen.getByRole("button", { name: /thought for 2s/i }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();

		await runtime.dispose();
	});

	it("offers Try again on an errored reply and re-drives the SAME run in place (no duplicated turn, #230)", async () => {
		const user = userEvent.setup();
		// run/retry accepted → the bridge re-streams the SAME run via subscribeRun.
		const retrySpy = vi.fn((_runId: string) =>
			Effect.succeed({ outcome: "accepted" as const }),
		);
		const runtime = makeStubRuntime({
			runId: "r-fail",
			events: [{ kind: "text_delta", delta: "recovered" }, { kind: "done" }],
			retryRun: retrySpy,
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

		// The retried run streams its new text into the SAME bubble.
		expect(await screen.findByText("recovered")).toBeInTheDocument();
		// run/retry was fired for the errored bubble's OWN run id — NOT a re-send.
		expect(retrySpy).toHaveBeenCalledWith("r-fail");
		// No seedTurn duplication: still one user + one assistant message.
		const msgs = getChatState().threads.threadA?.messages ?? [];
		expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
		expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);

		await runtime.dispose();
	});

	it("re-SENDS (not run/retry) when a failed-send bubble has no run id yet (#230 regression guard)", async () => {
		const user = userEvent.setup();
		// A bubble whose SEND failed before Core minted a Run keeps run_id "" (seedTurn
		// seeds "", a postMessage failure only flips status to incomplete). Its "Try
		// again" must re-SEND the prior prompt as a fresh Run — `run/retry` needs a real
		// errored run id, and an empty one is a dead button (Core rejects invalid_params).
		const retrySpy = vi.fn((_runId: string) =>
			Effect.succeed({ outcome: "accepted" as const }),
		);
		const runtime = makeStubRuntime({
			runId: "r-resent",
			events: [{ kind: "text_delta", delta: "resent reply" }, { kind: "done" }],
			retryRun: retrySpy,
		});
		appendUserMessage("threadA", {
			id: "u1",
			role: "user",
			status: "completed",
			segments: [{ kind: "text", text: "do it" }],
			run_id: "",
		});
		seedAssistantMessage("threadA", {
			id: "a-nosend",
			role: "assistant",
			status: "incomplete",
			segments: [],
			run_id: "", // never reached Core — no run id
		});

		await renderFocused(runtime, "threadA");
		await user.click(screen.getByRole("button", { name: /try again/i }));

		// The resend path streams a fresh Run's reply; run/retry is NEVER called for
		// the empty id (the dead-button regression).
		expect(await screen.findByText("resent reply")).toBeInTheDocument();
		expect(retrySpy).not.toHaveBeenCalled();

		await runtime.dispose();
	});

	it("shows the connection-specific copy when a focused-thread send fails because the link is down (ADR-0051)", async () => {
		const user = userEvent.setup();
		// The SDK postMessage rejects in the E channel with a connection-caused
		// WsError; the real bridge `send` squash must surface its `reason` so the
		// banner reads the link-down copy, not the generic "try again".
		const runtime = makeStubRuntime({
			runId: "run-down",
			events: [],
			sendFailure: new WsRequestError({ reason: "connection_lost" }),
		});

		await renderFocused(runtime, "threadA");

		await user.type(screen.getByRole("textbox", { name: /message/i }), "hi");
		await user.click(screen.getByRole("button", { name: /send/i }));

		// A focused-thread send also settles the seeded bubble as incomplete (its own
		// `role="alert"` notice), so target the send-error banner by its copy text.
		const banner = await screen.findByText(CONNECTION_SEND_FAILURE);
		expect(banner).toHaveAttribute("role", "alert");
		// The raw reason token never leaks into user copy (BookmarkEditor precedent).
		expect(banner).not.toHaveTextContent("connection_lost");

		await runtime.dispose();
	});

	it("keeps the generic copy when a focused-thread send fails for a non-connection reason", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime({
			runId: "run-other",
			events: [],
			sendFailure: new WsRequestError({ reason: "decode_failed" }),
		});

		await renderFocused(runtime, "threadA");

		await user.type(screen.getByRole("textbox", { name: /message/i }), "hi");
		await user.click(screen.getByRole("button", { name: /send/i }));

		const banner = await screen.findByText(GENERIC_SEND_FAILURE);
		expect(banner).toHaveAttribute("role", "alert");

		await runtime.dispose();
	});

	it("shows the connection-specific copy when the FIRST send (mint-on-send) fails because the link is down", async () => {
		const user = userEvent.setup();
		// From `/` (no focused thread) the first send mints via `threadCreate`; a
		// connection-caused failure there must read the same link-down copy.
		const runtime = makeStubRuntime({
			runId: "run-mint-down",
			events: [],
			sendFailure: new WsRequestError({ reason: "send_failed" }),
		});

		await renderChatRoute(<ChatColumn />, { runtime, path: "/" });

		await user.type(screen.getByRole("textbox", { name: /message/i }), "hello");
		await user.click(screen.getByRole("button", { name: /send/i }));

		// Mint-on-send seeds nothing on failure (no orphaned bubble), so the banner
		// is the only alert — but assert by copy text to stay symmetric with the
		// focused-thread cases above.
		const banner = await screen.findByText(CONNECTION_SEND_FAILURE);
		expect(banner).toHaveAttribute("role", "alert");

		await runtime.dispose();
	});
});
