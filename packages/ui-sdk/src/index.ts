import { Socket } from "@effect/platform";
import {
	EntityBacklinksResult,
	EntityListResult,
	type EntityMutateParams,
	EntityMutateResult,
	JournalEntryRescanResult,
	MediaUploadResult,
	MessageSearchResult,
	ModelCatalogResult,
	type ObservationQueryParams,
	ObservationQueryResult,
	type ObservationUpdateParams,
	ObservationUpdateResult,
	PostMessageResult,
	ProposalChangedNotification,
	type ProposalDecideParams,
	ProposalDecideResult,
	ProposalGetResult,
	ProposalPendingNotification,
	ProviderLoginStartResult,
	ProviderStatusResult,
	ProviderTestResult,
	type RecurrencePreviewParams,
	RecurrencePreviewResult,
	RunCancelResult,
	type RunEvent,
	RunEvent as RunEventSchema,
	RunHistoryResult,
	RunRetryResult,
	SettingsResult,
	ThreadCreateResult,
	ThreadGetResult,
	ThreadListResult,
	ThreadMutateResult,
} from "@inkstone/protocol";
import {
	Cause,
	Context,
	Data,
	Deferred,
	Duration,
	Effect,
	Either,
	Fiber,
	Layer,
	type ManagedRuntime,
	PubSub,
	Queue,
	Runtime,
	Schema as S,
	Schedule,
	Stream,
	SubscriptionRef,
} from "effect";

export type RunId = string;

/**
 * Socket-liveness signal (ADR-0051), derived purely from the client's own
 * socket lifecycle — NOT `provider/connected` (ADR-0049, OAuth state):
 * - `connected`     — socket open (or healed back open after a drop).
 * - `reconnecting`  — a post-open drop is in the fast-ramp retry window (a blip).
 * - `disconnected`  — the fast ramp lapsed; still retrying forever at the steady
 *                     interval ("down a while, retrying in the background").
 */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

// Two-phase reconnect cadence (ADR-0051, amends ADR-0020's bounded `times: 5`):
// the first RECONNECT_RAMP_ATTEMPTS drops retry on the ~50ms exponential ramp
// (the `reconnecting` window — laptop sleep / Core restart), then a STEADY
// interval FOREVER (the `disconnected` window). A short blip never leaves
// `reconnecting`; a long outage settles to `disconnected` while still retrying,
// so recovery is automatic with no page reload.
const RECONNECT_RAMP_ATTEMPTS = 5;
const RECONNECT_STEADY_INTERVAL = "5 seconds";

// Single source of truth (ADR-0051): the per-outage attempt count drives BOTH
// the status label AND the retry delay, so they can never disagree. For the
// Nth consecutive drop since the last open: while N is within the fast ramp the
// delay is the ~50ms exponential step (`50ms * 2^(N-1)`), matching the
// `reconnecting` label; once N passes the ramp the delay is the STEADY interval,
// matching `disconnected`. Because the counter resets to 0 in `onOpen`, a fresh
// outage after a reopen ramps from 50ms again — so the second outage in a
// session behaves identically to the first (NOT stuck in the steady phase, the
// bug a stateless composed `Schedule` produced: its driver only resets on the
// retried effect SUCCEEDING, but `connection` always fails to drive retry).
const reconnectDelay = (attempt: number): Duration.DurationInput =>
	attempt > RECONNECT_RAMP_ATTEMPTS
		? RECONNECT_STEADY_INTERVAL
		: Duration.millis(50 * 2 ** (attempt - 1));

export type RunEventValue = S.Schema.Type<typeof RunEvent>;

/** Request-level WS failure (ADR-0020: lives in the E channel). */
export class WsRequestError extends Data.TaggedError("WsRequestError")<{
	reason: string;
	code?: number;
	cause?: unknown;
}> {}

export class UnknownThreadError extends Data.TaggedError("UnknownThreadError")<{
	message: string;
}> {}

export class InvalidParamsError extends Data.TaggedError("InvalidParamsError")<{
	message: string;
}> {}

export class ProposalNotPendingError extends Data.TaggedError(
	"ProposalNotPendingError",
)<{
	message: string;
}> {}

export class ProviderLoginFailedError extends Data.TaggedError(
	"ProviderLoginFailedError",
)<{
	message: string;
}> {}

export type WsError =
	| WsRequestError
	| UnknownThreadError
	| InvalidParamsError
	| ProposalNotPendingError
	| ProviderLoginFailedError;

// Wire frame: response-with-result | response-with-error | notification.
const WireError = S.Struct({ code: S.Number, message: S.String });

const ResponseError = S.Struct({ id: S.Number, error: WireError });
const ResponseResult = S.Struct({ id: S.Number, result: S.Unknown });
const Notification = S.Struct({ method: S.String, params: S.Unknown });
// ResponseError is first: an error frame has no `result`, but `S.Unknown`
// accepts a missing property, so ResponseResult would otherwise match it.
const Envelope = S.Union(ResponseError, ResponseResult, Notification);
const decodeEnvelope = S.decodeUnknownEither(Envelope);

const RunEventNotification = S.Struct({
	run_id: S.String,
	event: RunEventSchema,
});
const decodeRunEventNotification = S.decodeUnknownEither(RunEventNotification);

const decodeProposalPending = S.decodeUnknownEither(
	ProposalPendingNotification,
);
const decodeProposalChanged = S.decodeUnknownEither(
	ProposalChangedNotification,
);

/** Tagged union the UI subscribes to over Core's proposal notifications (ADR-0025). */
export type ProposalNotification =
	| {
			readonly kind: "pending";
			readonly run_id: string;
			readonly proposal_id: string;
	  }
	| {
			readonly kind: "changed";
			readonly run_id: string;
			readonly proposal_id: string;
			readonly status: "accepted" | "rejected";
	  };

// run/subscribe acknowledgement is not a pinned protocol shape; accept {} or {run_id}.
const SubscribeAck = S.Struct({ run_id: S.optional(S.String) });

const mapWireError = (error: {
	readonly code: number;
	readonly message: string;
}): WsError => {
	if (error.code === -32001) {
		return new UnknownThreadError({ message: error.message });
	}
	if (error.code === -32002) {
		return new ProposalNotPendingError({ message: error.message });
	}
	if (error.code === -32003) {
		return new ProviderLoginFailedError({ message: error.message });
	}
	if (error.code === -32602) {
		return new InvalidParamsError({ message: error.message });
	}
	return new WsRequestError({ reason: error.message, code: error.code });
};

export class WsClientConfig extends Context.Tag(
	"@inkstone/ui-sdk/WsClientConfig",
)<WsClientConfig, { readonly url: string }>() {}

/**
 * One row per plain request/response verb: the wire `method`, `toParams`
 * (typing the verb's public arguments), the wire `result` schema, and an
 * optional `map` post-processing the decoded result (e.g. `postMessage`
 * collapsing to `run_id`). The `WsClient` tag's request surface, the live layer, AND
 * `stubWsClient` all derive from this ONE table, so adding a plain RPC verb
 * costs one row. The 4 stream members (`subscribeRun`,
 * `proposalNotifications`, `connectionStatus`, `notifications`) stay
 * hand-written on the tag — they are not request/response — and
 * `subscribeRun`'s snapshot-then-tail wire dance stays a hand-written
 * implementation.
 *
 * Exported for the table-driven round-trip test; production consumers use the
 * `WsClient` tag, never the table.
 */
export const requestDescriptors = {
	// thread/create + run/post_message (ADR-0058): optional `attachmentIds`
	// (ids from prior mediaUpload calls) ride as `attachment_ids` ONLY when
	// non-empty — an omitted/empty list serializes away, keeping the plain
	// text-send frame byte-identical to before.
	threadCreate: {
		method: "thread/create",
		toParams: (prompt: string, attachmentIds?: readonly string[]) =>
			attachmentIds?.length
				? { prompt, attachment_ids: attachmentIds }
				: { prompt },
		result: ThreadCreateResult,
	},
	postMessage: {
		method: "run/post_message",
		toParams: (
			threadId: string,
			prompt: string,
			attachmentIds?: readonly string[],
		) =>
			attachmentIds?.length
				? { thread_id: threadId, prompt, attachment_ids: attachmentIds }
				: { thread_id: threadId, prompt },
		result: PostMessageResult,
		map: (r: PostMessageResult): RunId => r.run_id,
	},
	// media/upload (ADR-0058): store image bytes ahead of a send — the minted
	// media_id then rides the send's `attachment_ids`. Bytes are RAW base64 (no
	// data: URL prefix); width/height are optional pixel dims the CLIENT
	// determined (Core never sniffs) and serialize away when unknown.
	mediaUpload: {
		method: "media/upload",
		toParams: (
			bytesBase64: string,
			mime: string,
			width?: number,
			height?: number,
		) => ({
			bytes_base64: bytesBase64,
			mime,
			...(width !== undefined ? { width } : {}),
			...(height !== undefined ? { height } : {}),
		}),
		result: MediaUploadResult,
	},
	threadList: {
		method: "thread/list",
		toParams: () => ({}),
		result: ThreadListResult,
	},
	// run/get_history (ADR-0028 as-built): the recent-Runs feed, newest-first.
	// A `limit` is sent only when given; omitting it lets Core apply its
	// default (an undefined field serializes away to `{}`).
	getRunHistory: {
		method: "run/get_history",
		toParams: (limit?: number) => (limit === undefined ? {} : { limit }),
		result: RunHistoryResult,
	},
	// recurrence/preview (ADR-0039 amendment, #227): preview the next
	// occurrence of a draft Recurrence Rule. Read-only — the editor sends an
	// in-progress rule + the Todo's current anchor dates and renders the
	// returned dates (or `ended`). `recurrence` rides as the opaque rule object.
	recurrencePreview: {
		method: "recurrence/preview",
		toParams: (params: RecurrencePreviewParams) => ({ ...params }),
		result: RecurrencePreviewResult,
	},
	threadGet: {
		method: "thread/get",
		toParams: (threadId: string) => ({ thread_id: threadId }),
		result: ThreadGetResult,
	},
	// thread/{rename,archive,unarchive,list_archived} (ADR-0052): the four
	// mutating/archived-list Thread verbs. The three mutators share
	// ThreadMutateResult (the affected thread_id; Core rejects an empty rename
	// title); list_archived mirrors thread/list but reads the archived set.
	threadRename: {
		method: "thread/rename",
		toParams: (threadId: string, title: string) => ({
			thread_id: threadId,
			title,
		}),
		result: ThreadMutateResult,
	},
	threadArchive: {
		method: "thread/archive",
		toParams: (threadId: string) => ({ thread_id: threadId }),
		result: ThreadMutateResult,
	},
	threadUnarchive: {
		method: "thread/unarchive",
		toParams: (threadId: string) => ({ thread_id: threadId }),
		result: ThreadMutateResult,
	},
	threadListArchived: {
		method: "thread/list_archived",
		toParams: () => ({}),
		result: ThreadListResult,
	},
	// entity/list (ADR-0004): accepted Entities of one type (e.g. journal_entry, todo).
	listEntities: {
		method: "entity/list",
		toParams: (type: string) => ({ type }),
		result: EntityListResult,
	},
	// entity/backlinks (ADR-0050): the two reverse sets the detail Inspector
	// shows for one Entity — mentioned_in (Journal Entries) + linked_todos.
	getBacklinks: {
		method: "entity/backlinks",
		toParams: (entityId: string) => ({ entity_id: entityId }),
		result: EntityBacklinksResult,
	},
	// observation/query (#253): read-only typed-observation fetch — an
	// all-optional filter object spread onto the wire like entityMutate.
	observationQuery: {
		method: "observation/query",
		toParams: (params: ObservationQueryParams) => ({ ...params }),
		result: ObservationQueryResult,
	},
	observationUpdate: {
		method: "observation/update",
		toParams: (params: ObservationUpdateParams) => ({ ...params }),
		result: ObservationUpdateResult,
	},
	// entity/mutate (ADR-0033): a user-initiated CRUD request — same
	// {mutation_kind, payload} envelope as the Worker's propose tool.
	entityMutate: {
		method: "entity/mutate",
		toParams: (params: EntityMutateParams) => ({ ...params }),
		result: EntityMutateResult,
	},
	// journal_entry/rescan (ADR-0042): re-scan an accepted Journal Entry for
	// mentioned-but-uncaptured entities. Core resolves the JE's origin Thread
	// and starts an agent Run there; the caller navigates to that Thread.
	rescanJournalEntry: {
		method: "journal_entry/rescan",
		toParams: (jeId: string) => ({ je_id: jeId }),
		result: JournalEntryRescanResult,
	},
	// message/search (ADR-0035): substring full-text search over completed Message text.
	messageSearch: {
		method: "message/search",
		toParams: (query: string) => ({ query }),
		result: MessageSearchResult,
	},
	// run/cancel (ADR-0014): ask Core to cancel a Run. For a running Run the
	// terminal `cancelled` Run Event also arrives over subscribeRun; for a
	// parked Run nothing is pushed, so the response outcome is authoritative.
	cancelRun: {
		method: "run/cancel",
		toParams: (runId: RunId) => ({ run_id: runId }),
		result: RunCancelResult,
	},
	// run/retry (ADR-0028 retry amendment, #230): ask Core to re-drive an
	// errored Run IN PLACE on the same run id. `accepted` means Core won the
	// `errored → running` flip and is re-streaming (its terminal arrives over
	// subscribeRun); `not_errored`/`unknown_run` are normal response values.
	retryRun: {
		method: "run/retry",
		toParams: (runId: RunId) => ({ run_id: runId }),
		result: RunRetryResult,
	},
	// provider/* (ADR-0023): connection status + begin OAuth login.
	providerStatus: {
		method: "provider/status",
		toParams: () => ({}),
		result: ProviderStatusResult,
	},
	providerLoginStart: {
		method: "provider/login_start",
		toParams: (provider: string) => ({ provider }),
		result: ProviderLoginStartResult,
	},
	// provider/configure (ADR-0062): store a static API key for a
	// key-configurable provider (OpenRouter); the result is the refreshed
	// provider/status, so the caller flips the row exactly like login does.
	providerConfigure: {
		method: "provider/configure",
		toParams: (provider: string, apiKey: string) => ({
			provider,
			api_key: apiKey,
		}),
		result: ProviderStatusResult,
	},
	// provider/test (ADR-0062): probe whether a provider actually answers, using
	// the given model. Provider-agnostic (codex + openrouter); spawns a one-shot
	// ephemeral Worker and persists nothing — the result is a transient liveness
	// verdict, not stored status.
	providerTest: {
		method: "provider/test",
		toParams: (provider: string, model: string) => ({ provider, model }),
		result: ProviderTestResult,
	},
	// model/catalog + settings/* (ADR-0024): catalog, preferred model, global effort.
	modelCatalog: {
		method: "model/catalog",
		toParams: () => ({}),
		result: ModelCatalogResult,
	},
	settingsGet: {
		method: "settings/get",
		toParams: () => ({}),
		result: SettingsResult,
	},
	settingsSet: {
		method: "settings/set",
		toParams: (params: {
			readonly model?: string;
			readonly effort?: string;
			readonly enabled_models?: readonly string[];
		}) => ({ ...params }),
		result: SettingsResult,
	},
	// proposal/* (ADR-0025): get a parked Run's pending Proposal and decide it.
	// proposalDecide is wire-wise a plain request (Core owns the idempotent
	// multi-step decide); the pushed pending/changed notifications stream over
	// the hand-written proposalNotifications member.
	proposalGet: {
		method: "proposal/get",
		toParams: (runId: RunId) => ({ run_id: runId }),
		result: ProposalGetResult,
	},
	proposalDecide: {
		method: "proposal/decide",
		toParams: (params: ProposalDecideParams) => ({ ...params }),
		result: ProposalDecideResult,
	},
} as const satisfies Record<
	string,
	{
		readonly method: string;
		// Contravariant param position: every concrete toParams is assignable to
		// (...a: never[]) => ..., while the Record return keeps each row honest —
		// the constraint the derivation casts below would otherwise erase.
		readonly toParams: (...a: never[]) => Record<string, unknown>;
		readonly result: S.Schema.Any;
		readonly map?: (r: never) => unknown;
	}
>;

type Descriptors = typeof requestDescriptors;
// `(r: never)` is the contravariant-match trick: every map fn extends it, so
// the conditional keys on map's PRESENCE and infers its return. Don't "fix" it
// to `unknown` — that inverts the variance and breaks the inference.
type VerbResult<K extends keyof Descriptors> = Descriptors[K] extends {
	readonly map: (r: never) => infer B;
}
	? B
	: S.Schema.Type<Descriptors[K]["result"]>;

/** The request-verb half of the WsClient service, derived from the table. */
export type RequestVerbs = {
	readonly [K in keyof Descriptors]: (
		...args: Parameters<Descriptors[K]["toParams"]>
	) => Effect.Effect<VerbResult<K>, WsError>;
};

export class WsClient extends Context.Tag("@inkstone/ui-sdk/WsClient")<
	WsClient,
	RequestVerbs & {
		readonly subscribeRun: (
			runId: RunId,
		) => Stream.Stream<RunEventValue, WsError>;
		readonly proposalNotifications: () => Stream.Stream<ProposalNotification>;
		// Socket-liveness state stream (ADR-0051). No error channel — a pure
		// state stream; `SubscriptionRef.changes` replays the CURRENT value on
		// subscribe (then streams changes), so an indicator mounting long after
		// boot gets the live status immediately, not just future transitions.
		readonly connectionStatus: () => Stream.Stream<ConnectionStatus>;
		// Generic run-less notification stream (ADR-0047 amendment): decoded
		// pushes for one inbound `method`, decode-dropping frames that fail the
		// caller-supplied `schema`. At-most-once — a method with no live
		// subscriber drops its frames, and nothing buffers while unsubscribed.
		readonly notifications: <A, I>(
			method: string,
			schema: S.Schema<A, I>,
		) => Stream.Stream<A>;
	}
>() {}

/** The full WsClient service shape — every verb + stream member. */
export type WsClientService = Context.Tag.Service<typeof WsClient>;

/**
 * Build a WsClient test double: `overrides` replaces exactly the members a test
 * exercises; every other member gets a safe default. The two default kinds encode
 * the members' distinct failure semantics:
 *
 * - The 28 request VERBS default to `Effect.die("WsClient.<method> not stubbed")`.
 *   A verb returns a value the code under test asserts on, so an un-stubbed call
 *   must fail LOUD with a named cause — never silently return a wrong value.
 * - The 4 STREAM members (`subscribeRun`, `proposalNotifications`,
 *   `connectionStatus`, `notifications`) default to `Stream.empty`. These are
 *   subscribed passively at mount (the connection pill, the proposal channel, a
 *   run's event feed, a route's notification effect); an empty stream is the
 *   honest "no events" quiescent state, so a component mounts cleanly without
 *   the test having to hand-stub a stream it does not drive. A test that DOES
 *   drive events overrides the member with a real stream.
 *
 * The `Partial<WsClientService>` spread stays compiler-checked, so a NEW verb
 * added to the tag makes this factory (and thus the whole suite) fail typecheck
 * until handled — the same safety the old hand-listed stubs gave, minus the
 * ~1000-line, 37-file stub blast on every verb addition.
 *
 * Test-only: it lives in the shipped `@inkstone/ui-sdk` surface (so web specs can
 * import it) but constructs nothing live and is never used by production code.
 */
export function stubWsClient(
	overrides: Partial<WsClientService> = {},
): WsClientService {
	const die = (method: string) => () =>
		Effect.die(`WsClient.${method} not stubbed`);
	// Derived from the descriptor table. The cast crosses fromEntries' index
	// signature; the compiler-check property survives structurally: the tag's
	// request half IS `RequestVerbs` (derived from the same table these keys
	// come from), and `WsClient.of` below still demands every stream member —
	// so a new table row is auto-stubbed and a new hand member still reds here.
	const verbs = Object.fromEntries(
		Object.keys(requestDescriptors).map((k) => [k, die(k)]),
	) as unknown as RequestVerbs;
	return WsClient.of({
		...verbs,
		subscribeRun: () => Stream.empty,
		proposalNotifications: () => Stream.empty,
		connectionStatus: () => Stream.empty,
		notifications: () => Stream.empty,
		...overrides,
	});
}

/**
 * React sugar over {@link WsClient}'s `notifications` stream: fork one
 * subscription on `runtime`, calling `onValue` per decoded push. The returned
 * disposer interrupts the fiber — exactly a `useEffect` cleanup.
 */
export function onNotification<A, I>(
	runtime: ManagedRuntime.ManagedRuntime<WsClient, never>,
	method: string,
	schema: S.Schema<A, I>,
	onValue: (value: A) => void,
): () => void {
	const fiber = runtime.runFork(
		Effect.flatMap(WsClient, (client) =>
			Stream.runForEach(client.notifications(method, schema), (value) =>
				// Contain a throwing `onValue` per frame so one bad callback invocation
				// can't fail the whole subscription fiber and silently stop later
				// notifications — the per-frame isolation the old registry's try/catch gave.
				Effect.sync(() => {
					try {
						onValue(value);
					} catch {}
				}),
			),
		),
	);
	return () => {
		runtime.runFork(Fiber.interrupt(fiber));
	};
}

export const WsClientLive: Layer.Layer<WsClient, never, WsClientConfig> =
	Layer.scoped(
		WsClient,
		Effect.gen(function* () {
			const cfg = yield* WsClientConfig;
			const runtime = yield* Effect.runtime<never>();
			const runFork = Runtime.runFork(runtime);
			const runSync = Runtime.runSync(runtime);

			const pending = new Map<number, Deferred.Deferred<unknown, WsError>>();
			const runQueues = new Map<RunId, Queue.Queue<RunEventValue>>();
			// Shared, lazily-created proposal/* queue (ADR-0025) — see docs/design/ui-sdk.md
			let proposalQueue: Queue.Queue<ProposalNotification> | undefined;
			// Per-method run-less notification hubs (ADR-0047 amendment): lazily
			// created on first subscribe, refcounted, torn down by the last
			// unsubscriber — so a method with no live subscriber has NO entry and
			// its frames drop in onFrame (at-most-once, nothing buffers).
			const notificationHubs = new Map<
				string,
				{ pubsub: PubSub.PubSub<unknown>; refs: number }
			>();
			let nextId = 1;

			// Socket-liveness state (ADR-0051). Starts `connected` since the layer
			// build blocks on first open below; set at the three lifecycle points
			// (onOpen → connected, per-drop → reconnecting, ramp-lapse → disconnected).
			const statusRef =
				yield* SubscriptionRef.make<ConnectionStatus>("connected");

			const ensureProposalQueue = (): Queue.Queue<ProposalNotification> => {
				if (proposalQueue === undefined) {
					proposalQueue = runSync(Queue.unbounded<ProposalNotification>());
				}
				return proposalQueue;
			};

			const ensureQueue = (runId: RunId): Queue.Queue<RunEventValue> => {
				let queue = runQueues.get(runId);
				if (queue === undefined) {
					queue = runSync(Queue.unbounded<RunEventValue>());
					runQueues.set(runId, queue);
				}
				return queue;
			};

			// Decode + dispatch one inbound frame: responses resolve `pending`
			// Deferreds; notifications offer onto per-run/proposal queues.
			const onFrame = (raw: string): void => {
				const decoded = decodeEnvelope(JSON.parse(raw));
				if (Either.isLeft(decoded)) {
					return;
				}
				const frame = decoded.right;
				if ("id" in frame) {
					const deferred = pending.get(frame.id);
					if (deferred === undefined) {
						return;
					}
					pending.delete(frame.id);
					if ("error" in frame) {
						runFork(Deferred.fail(deferred, mapWireError(frame.error)));
					} else {
						runFork(Deferred.succeed(deferred, frame.result));
					}
					return;
				}
				if (frame.method === "run/event") {
					const event = decodeRunEventNotification(frame.params);
					if (Either.isRight(event)) {
						const queue = ensureQueue(event.right.run_id);
						Queue.unsafeOffer(queue, event.right.event);
					}
					return;
				}
				if (frame.method === "proposal/pending") {
					const n = decodeProposalPending(frame.params);
					if (Either.isRight(n)) {
						Queue.unsafeOffer(ensureProposalQueue(), {
							kind: "pending",
							run_id: n.right.run_id,
							proposal_id: n.right.proposal_id,
						});
					}
					return;
				}
				if (frame.method === "proposal/changed") {
					const n = decodeProposalChanged(frame.params);
					if (Either.isRight(n)) {
						Queue.unsafeOffer(ensureProposalQueue(), {
							kind: "changed",
							run_id: n.right.run_id,
							proposal_id: n.right.proposal_id,
							status: n.right.status,
						});
					}
					return;
				}
				// Generic fallthrough (ADR-0047): publish any other notification's
				// raw `params` to its method's hub — only when a subscriber already
				// created one. An unsubscribed method stays a silent no-op
				// (preserves the drop-unknown behavior); decode happens at the
				// subscription edge with the caller-supplied schema.
				const hub = notificationHubs.get(frame.method);
				if (hub !== undefined) {
					Queue.unsafeOffer(hub.pubsub, frame.params);
				}
			};

			// Constructs the Socket value (connection opens at runRaw); global
			// WebSocketConstructor provided internally to avoid an R leak — see docs/design/ui-sdk.md
			const socket = yield* Socket.makeWebSocket(cfg.url).pipe(
				Effect.provide(Socket.layerWebSocketConstructorGlobal),
			);

			// writer blocks on an internal latch until open, so sends during a
			// reconnect window wait for the fresh connection.
			const write = yield* socket.writer;

			const decoder = new TextDecoder();

			// Fails in-flight requests with connection_lost AND injects a synthetic
			// error event into active run queues so `subscribeRun` streams surface the
			// drop as a terminal "connection_lost" error event (the bridge's
			// takeUntil catches it and applies the "lost connection" notice). No
			// resubscribe-replay — see docs/design/ui-sdk.md.
			const failPending = Effect.sync(() => {
				for (const deferred of pending.values()) {
					runFork(
						Deferred.fail(
							deferred,
							new WsRequestError({ reason: "connection_lost" }),
						),
					);
				}
				pending.clear();
				for (const queue of runQueues.values()) {
					runFork(
						Queue.offer(queue, {
							kind: "error",
							message:
								"Lost the connection before this reply finished. Check that Inkstone is running, then try again.",
						} as RunEventValue).pipe(Effect.zipRight(Queue.shutdown(queue))),
					);
				}
				runQueues.clear();
			});

			// First-open failure stays a defect; only post-open drops are recoverable (ADR-0020) — see docs/design/ui-sdk.md
			let hasOpened = false;
			// Consecutive failed reconnect attempts since the last open. Drives the
			// `reconnecting` → `disconnected` boundary off the ATTEMPT COUNT (not
			// wall-clock) so the transition is deterministic and tests aren't flaky
			// (ADR-0051). Reset to 0 in `onOpen` when the link heals.
			let reconnectAttempts = 0;
			const firstOpen = yield* Deferred.make<void>();
			const onOpen = Effect.sync(() => {
				hasOpened = true;
				// Drives `connected` on every (re)open, so a healed link returns to
				// `connected` automatically (ADR-0051). The drop arm resets the
				// ramp counter so the next outage starts its ramp fresh.
				reconnectAttempts = 0;
			}).pipe(
				Effect.zipRight(SubscriptionRef.set(statusRef, "connected")),
				Effect.zipRight(Deferred.succeed(firstOpen, void 0)),
				Effect.asVoid,
			);

			// One connection lifetime; failed uniformly on end (incl. clean close) to drive retry — see docs/design/ui-sdk.md
			const connection = socket
				.runRaw(
					(data) =>
						onFrame(typeof data === "string" ? data : decoder.decode(data)),
					{ onOpen },
				)
				.pipe(Effect.zipRight(Effect.fail("dropped" as const)));

			// Each drop: fail in-flight requests, then drive the liveness signal off
			// the consecutive-attempt count (ADR-0051). Within the fast ramp the link
			// is `reconnecting` (a blip); once the ramp lapses it settles to
			// `disconnected` — but keeps retrying forever, so this is "down a while,
			// still retrying," NOT a terminal give-up. The count is reset in `onOpen`.
			// The next status is computed INSIDE the sync (per drop), not captured at
			// construction, so the boundary is re-evaluated on every attempt.
			const onDrop = failPending.pipe(
				Effect.zipRight(
					Effect.sync((): ConnectionStatus => {
						reconnectAttempts += 1;
						return reconnectAttempts > RECONNECT_RAMP_ATTEMPTS
							? "disconnected"
							: "reconnecting";
					}),
				),
				Effect.flatMap((status) => SubscriptionRef.set(statusRef, status)),
			);

			// Unbounded two-phase reconnect (ADR-0051, amends ADR-0020): one source of
			// truth. `tapError` runs `onDrop` (which increments `reconnectAttempts`)
			// BEFORE the schedule computes this step's delay, so `reconnectDelay` reads
			// the SAME counter value that picked the status label — the ~50ms ramp while
			// `reconnecting`, the steady interval while `disconnected`. A bare
			// `Schedule.forever` is unbounded (`times: 5` is GONE — the fiber no longer
			// dies after a handful of drops; it re-opens whenever Core returns); the
			// counter-driven `delayed` supplies the cadence. A stateless composed
			// `Schedule` could NOT do this: its internal driver only resets when the
			// retried effect SUCCEEDS, but `connection` always fails (to drive retry),
			// so it advanced monotonically across the Layer lifetime and a fresh blip
			// after a long outage stalled at the steady interval while the reset counter
			// still showed `reconnecting`. Keying the delay off `reconnectAttempts` (reset
			// in `onOpen`) makes the Nth outage in a session ramp exactly like the first.
			// `while: hasOpened` is retained so a FIRST-open failure still propagates
			// (the layer build dies, an ADR-0020 defect); only post-open drops retry.
			const reconnectSchedule = Schedule.forever.pipe(
				Schedule.delayed(() => reconnectDelay(reconnectAttempts)),
			);
			const supervised = connection.pipe(
				Effect.tapError(() => onDrop),
				Effect.retry({
					schedule: reconnectSchedule,
					while: () => hasOpened,
				}),
			);

			// Fork the receive/reconnect loop into the layer scope (interrupted on teardown).
			const fiber = yield* Effect.forkScoped(supervised);

			// Block layer construction until first open; if the loop ends first, die.
			yield* Deferred.await(firstOpen).pipe(
				Effect.raceFirst(
					Fiber.join(fiber).pipe(
						Effect.matchCauseEffect({
							onFailure: (cause) => Effect.die(Cause.squash(cause)),
							onSuccess: () =>
								Effect.die(new Error("socket closed before opening")),
						}),
					),
				),
			);

			const request = <A, I>(
				method: string,
				params: Record<string, unknown>,
				schema: S.Schema<A, I>,
			): Effect.Effect<A, WsError> =>
				Effect.gen(function* () {
					const id = nextId++;
					const deferred = yield* Deferred.make<unknown, WsError>();
					pending.set(id, deferred);
					yield* write(
						JSON.stringify({ jsonrpc: "2.0", id, method, params }),
					).pipe(
						Effect.mapError(
							(cause) => new WsRequestError({ reason: "send_failed", cause }),
						),
					);
					const result = yield* Deferred.await(deferred);
					return yield* S.decodeUnknown(schema)(result).pipe(
						Effect.mapError(
							(cause) => new WsRequestError({ reason: "decode_failed", cause }),
						),
					);
				});

			// Every request/response verb derives from `requestDescriptors`: send
			// `d.method` with `d.toParams(...args)`, decode with `d.result`, apply
			// `d.map` when present. The cast at the end is the one seam between the
			// table's per-row types and the mapped-object type — the round-trip test
			// exercises every row against a live socket, so a row whose closure
			// misbehaved would fail there, not hide behind the cast.
			const verbs = Object.fromEntries(
				Object.entries(requestDescriptors).map(([k, d]) => [
					k,
					(...args: never[]) => {
						const sent = request(
							d.method,
							(d.toParams as (...a: never[]) => Record<string, unknown>)(
								...args,
							),
							d.result as S.Schema<unknown>,
						);
						return "map" in d
							? sent.pipe(Effect.map(d.map as (r: unknown) => unknown))
							: sent;
					},
				]),
			) as unknown as RequestVerbs;

			// Queue is created before run/subscribe is sent so post-ack events aren't dropped — see docs/design/ui-sdk.md
			const subscribeRun = (
				runId: RunId,
			): Stream.Stream<RunEventValue, WsError> =>
				Stream.unwrap(
					Effect.gen(function* () {
						const queue = ensureQueue(runId);
						yield* request("run/subscribe", { run_id: runId }, SubscribeAck);
						return Stream.fromQueue(queue);
					}),
				);

			const proposalNotifications = (): Stream.Stream<ProposalNotification> =>
				Stream.fromQueue(ensureProposalQueue());

			// `.changes` replays the current value on subscribe, then streams every
			// transition — the property the indicator needs to render the LIVE status
			// when it mounts after boot, not "unknown" until the next drop (ADR-0051).
			const connectionStatus = (): Stream.Stream<ConnectionStatus> =>
				statusRef.changes;

			// First subscriber creates the method's hub; later ones share it.
			const acquireHub = (
				method: string,
			): Effect.Effect<PubSub.PubSub<unknown>> =>
				Effect.sync(() => {
					let entry = notificationHubs.get(method);
					if (entry === undefined) {
						entry = { pubsub: runSync(PubSub.unbounded<unknown>()), refs: 0 };
						notificationHubs.set(method, entry);
					}
					entry.refs += 1;
					return entry.pubsub;
				});

			// Last unsubscriber shuts the hub down and drops the map entry, so
			// onFrame's lookup misses and the method's frames drop again.
			const releaseHub = (method: string): Effect.Effect<void> =>
				Effect.suspend(() => {
					const entry = notificationHubs.get(method);
					if (entry === undefined) {
						return Effect.void;
					}
					entry.refs -= 1;
					if (entry.refs > 0) {
						return Effect.void;
					}
					notificationHubs.delete(method);
					return PubSub.shutdown(entry.pubsub);
				});

			// Run-less notification stream (ADR-0047 amendment): a PubSub (broadcast
			// fan-out — every subscriber sees every frame) over the method's raw
			// pushed `params`, decode-dropped with the caller's schema at the
			// subscription edge (mirroring the run/event arm). `{ scoped: true }`
			// subscribes inside the SAME scope the hub was acquired in, closing the
			// acquire→subscribe drop window.
			const notifications = <A, I>(
				method: string,
				schema: S.Schema<A, I>,
			): Stream.Stream<A> => {
				const decode = S.decodeUnknownEither(schema);
				return Stream.unwrapScoped(
					Effect.gen(function* () {
						const pubsub = yield* Effect.acquireRelease(
							acquireHub(method),
							() => releaseHub(method),
						);
						const raw = yield* Stream.fromPubSub(pubsub, { scoped: true });
						return raw.pipe(
							Stream.filterMap((params) => Either.getRight(decode(params))),
						);
					}),
				);
			};

			return WsClient.of({
				...verbs,
				subscribeRun,
				proposalNotifications,
				connectionStatus,
				notifications,
			});
		}),
	);
