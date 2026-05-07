/**
 * `prompt` user-verb — the LLM-turn entry point.
 *
 * Owns the persist-first user-bubble write, turn-clock + thinking-
 * level snapshots, the Codex pre-turn WebSocket counter capture, the
 * background session-title task kickoff, and the pre-stream error
 * handler that synthesizes a failure bubble when the provider rejects
 * before pi-agent-core's first stream event.
 *
 * Lives in its own file so the (largest, densest) action body has
 * room for its own helpers without bloating the verb router.
 */

import {
	appendDisplayMessage,
	newId,
	runInTransaction,
	safeRun,
	updateDisplayMessageMeta,
	updateSessionTitle,
} from "@backend/persistence/sessions";
import type { DisplayMessage, DisplayPart } from "@bridge/view-model";
import { getOpenAICodexWebSocketDebugStats } from "@mariozechner/pi-ai/openai-codex-responses";
import { batch } from "solid-js";
import { produce } from "solid-js/store";
import { toBottom } from "../../../app";
import type { ActionDeps } from "../actions";

export async function promptAction(
	text: string,
	displayParts: DisplayPart[] | undefined,
	deps: ActionDeps,
): Promise<void> {
	const sessionId = deps.sessionState.ensureSession();
	const shouldGenerateTitle = deps.store.messages.length === 0;
	const titleProviderId = deps.store.modelProvider;
	const titleModelId = deps.agentSession.getModelId();
	// LLM text vs. bubble display split: when a command supplies
	// `displayParts` (reader's `/article` does), use those verbatim
	// so the bubble can render a file chip instead of the full
	// content; otherwise fall back to the one-text-part shape that
	// covers plain prompts. pi-agent-core only ever sees `text`, so
	// whatever the LLM needs must be in `text`.
	const userMsg: DisplayMessage = {
		id: newId(),
		role: "user",
		parts: displayParts ?? [{ type: "text", text }],
	};
	// Persist-first: push the user bubble, stamp the turn clock, and
	// start the LLM turn only if the insert committed. On failure,
	// `reportPersistenceError` has already toasted and `prompt.tsx`
	// has already cleared the input — the user retypes. Short-
	// circuiting here keeps store/disk in sync.
	let persisted = false;
	deps.sessionState.persistThen(
		(tx) => appendDisplayMessage(tx, sessionId, userMsg),
		() => {
			persisted = true;
			deps.setStore(
				"messages",
				produce((msgs: DisplayMessage[]) => {
					msgs.push(userMsg);
				}),
			);
			deps.setStore("lastTurnStartedAt", Date.now());
			// Snapshot the effort at turn-start so agent_end can stamp
			// the turn-closing bubble with the value that produced it,
			// not whatever the store holds at event time.
			deps.sessionState.setTurnStartThinkingLevel(deps.store.thinkingLevel);
			// Pre-turn snapshot of pi-ai's Codex WebSocket connection
			// counter. Read in `agent_end` to decide whether this turn
			// ran on WebSocket (counter advanced) or fell back to SSE
			// (counter unchanged). `getOpenAICodexWebSocketDebugStats`
			// returns `undefined` when no WebSocket has ever been
			// opened for this sessionId — we normalize to 0 so the
			// "no change" branch reads as "SSE used" on the first turn,
			// which is the correct semantic for a brand-new session
			// whose first turn couldn't open a WebSocket. Only
			// meaningful when Codex is the active provider; other
			// providers don't touch the counter, so the diff trivially
			// reads 0 — benign.
			if (deps.store.modelProvider === "openai-codex") {
				const stats = getOpenAICodexWebSocketDebugStats(sessionId);
				deps.sessionState.setPreTurnCodexConnections(
					(stats?.connectionsCreated ?? 0) + (stats?.connectionsReused ?? 0),
				);
			} else {
				deps.sessionState.setPreTurnCodexConnections(undefined);
			}
			if (shouldGenerateTitle) {
				startSessionTitleTask(
					{
						sessionId,
						activeProviderId: titleProviderId,
						activeModelId: titleModelId,
						prompt: text,
					},
					deps,
				);
			}
			toBottom();
		},
	);
	if (!persisted) return;
	// Guard against a pre-stream throw from `actions.prompt()`.
	// pi-agent-core funnels most provider errors through `message_end`
	// with `stopReason === "error"`, which the reducer already surfaces
	// onto the bubble. But failures *before* the first stream event —
	// `getApiKey()` rejection, a network error on the first request,
	// a thrown provider factory — bypass that path. Without a catch
	// here, `wrappedActions.prompt` rejects and the fire-and-forget
	// call sites in `prompt.tsx` turn into unhandled rejections that
	// can crash the process.
	try {
		await deps.agentSession.actions.prompt(text);
	} catch (err) {
		handlePreStreamError(err, deps);
	}
}

function startSessionTitleTask(
	params: {
		sessionId: string;
		activeProviderId: string;
		activeModelId: string;
		prompt: string;
	},
	deps: ActionDeps,
): void {
	void deps
		.titleGenerator(params)
		.then((title) => {
			if (!title) return;
			deps.sessionState.persistThen(
				(tx) => updateSessionTitle(tx, params.sessionId, title),
				() => {
					if (deps.sessionState.getCurrentSessionId() === params.sessionId) {
						deps.setStore("sessionTitle", title);
					}
				},
			);
		})
		.catch((error) => {
			// Expected title-gen failures (completeSimple throws on
			// primary and retry) are caught inside `generateSessionTitle`
			// and logged there with the resolved model ids. This outer
			// catch only fires on truly unexpected throws from
			// orchestration steps NOT wrapped by the inner try/catch —
			// e.g. `provider.getApiKey()` rejecting, or `loadConfig()`
			// throwing inside `resolveTitleModel`. Log the active params
			// so the next layer up has something to debug with.
			console.error(
				`[inkstone] session title task failed (active: ${params.activeProviderId}/${params.activeModelId}):`,
				error,
			);
		});
}

function handlePreStreamError(err: unknown, deps: ActionDeps): void {
	const msg = err instanceof Error ? err.message : String(err);
	batch(() => {
		deps.setStore("isStreaming", false);
		deps.setStore("status", "idle");
		const lastIdx = deps.store.messages.length - 1;
		const last = deps.store.messages[lastIdx];
		if (last && last.role === "assistant") {
			deps.setStore("messages", lastIdx, "error", msg);
			const updated = deps.store.messages[lastIdx];
			const sid = deps.sessionState.getCurrentSessionId();
			if (sid && updated) {
				// safeRun: no store state to gate. The in-memory bubble
				// already shows the error; a persistence failure here
				// just means the error won't appear on resume, which is
				// acceptable since the agent turn already failed.
				safeRun(() =>
					runInTransaction((tx) => updateDisplayMessageMeta(tx, sid, updated)),
				);
			}
		} else {
			// No assistant bubble was ever pushed (failure happened
			// before `message_start`). Append a synthetic one so the
			// error has a render target.
			const synthetic: DisplayMessage = {
				id: newId(),
				role: "assistant",
				parts: [],
				error: msg,
			};
			deps.setStore(
				"messages",
				produce((msgs: DisplayMessage[]) => {
					msgs.push(synthetic);
				}),
			);
			const sid = deps.sessionState.getCurrentSessionId();
			if (sid) {
				// safeRun: synthetic bubble is best-effort. If the insert
				// fails, the in-memory view still shows the error — resume
				// will miss this particular failure marker but the
				// session timeline stays valid.
				safeRun(() =>
					runInTransaction((tx) => appendDisplayMessage(tx, sid, synthetic)),
				);
			}
		}
	});
	deps.toast.show({
		variant: "error",
		title: "Agent error",
		message: msg,
		duration: 6000,
	});
}
