import type { ThreadGetResult, TranscriptToolResult } from "@inkstone/protocol";

// The assistant-turn TIMELINE model + its pure reducers (ADR-0045), extracted
// from the Zustand store module (review F3): the wire→segment mapping and the
// segment-array transforms that build a turn's ordered timeline. Every function
// here is PURE over `Segment[]` — no store/`ChatState` dependency — so the store
// module (`chat.ts`) owns only state wiring, and these reducers are unit-testable
// in isolation. `chat.ts` re-exports the public types + `toSegment`/`concatText`
// so existing `@/store/chat` importers are unaffected.

/** A tool call surfaced live within an assistant turn (ADR-0006 tool_call Run Event). */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly status: "running" | "completed" | "error";
	/** The tool's display argument (ADR-0043), e.g. a search query; absent for argless tools. */
	readonly arg?: string;
	/** The normalized result the model received (external-task-views A4):
	 * carried on terminal events of external (`ticktick_*`) calls so the
	 * collapsed row can expand to it — identically live and after reload. */
	readonly result?: TranscriptToolResult;
}

/**
 * One item in an assistant turn's ordered timeline (ADR-0045): a contiguous run
 * of text, a tool-call boundary, a positional marker for the Proposal card, or a
 * `reasoning` (thinking) trace. The `proposal` segment carries ONLY `runId` — the
 * {@link PendingProposal} map stays the source of interactive state; this segment
 * just says "the card renders HERE in the timeline". The `reasoning` kind (ADR-0045
 * amendment, #202) is now realized — the model's thinking, default-collapsed, with
 * an optional `durationMs` (web-clocked live open→seal, Core-computed on reload). It
 * is EXCLUDED from {@link concatText}, so the trace never leaks into the reply text.
 * The `attachment` kind (ADR-0058) is an image on a user Message — the bytes live
 * at `GET /media/{mediaId}`; `width`/`height` are pixel dims when known. It carries
 * no text, so {@link concatText} excludes it by construction.
 */
export type Segment =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "tool_call"; readonly call: ToolCall }
	| { readonly kind: "proposal"; readonly runId: string }
	| {
			readonly kind: "reasoning";
			readonly text: string;
			readonly durationMs?: number;
	  }
	| {
			readonly kind: "attachment";
			readonly mediaId: string;
			readonly mime: string;
			readonly width?: number;
			readonly height?: number;
	  };

/** One wire `Segment` — from a `thread/get` result OR a `run/subscribe`
 * `snapshot` Run Event (both carry the same `protocol::Segment`). */
export type WireSegment =
	ThreadGetResult["messages"][number]["segments"][number];

/** A wire tool-call status → the live `tool_call` segment status. `running` (a
 * live `snapshot`'s in-flight call, review P1 #2) and `error` keep their
 * spelling; anything else (a rehydrated `thread/get` call is `completed`)
 * settles to `completed`. */
function toToolCallStatus(status: string): "running" | "completed" | "error" {
	if (status === "running") return "running";
	if (status === "error") return "error";
	return "completed";
}

/** Map one wire `Segment` to a live store {@link Segment} (ADR-0045), preserving
 * its timeline position — SHARED by `thread/get` rehydration and the
 * `run/subscribe` `snapshot` event (review P1 #2). A `tool_call` keys on the
 * durable `tool_call_id` (external-task-views A4) and carries the model-received
 * `result`; a wire `proposal` becomes a positional `{kind:"proposal", runId}`
 * marker (its interactive state lives in the `proposals` map, seeded separately). */
export function toSegment(runId: string, segment: WireSegment): Segment {
	switch (segment.kind) {
		case "text":
			return { kind: "text", text: segment.text };
		case "tool_call":
			return {
				kind: "tool_call",
				call: {
					id: segment.tool_call_id,
					name: segment.name,
					status: toToolCallStatus(segment.status),
					arg: segment.arg,
					result: segment.result,
				},
			};
		case "proposal":
			return { kind: "proposal", runId };
		case "reasoning":
			return {
				kind: "reasoning",
				text: segment.text,
				durationMs: segment.duration_ms,
			};
		case "attachment":
			return {
				kind: "attachment",
				mediaId: segment.media_id,
				mime: segment.mime,
				width: segment.width,
				height: segment.height,
			};
	}
}

/** Concatenate the text of every `text` segment in order — the single source for the
 * flat reply text the copy button, ⌘K search-match, typing-indicator, and retry read
 * (ADR-0045: there is no denormalized flat `text`; it derives from segments). */
export function concatText(segments: readonly Segment[]): string {
	let text = "";
	for (const seg of segments) {
		if (seg.kind === "text") text += seg.text;
	}
	return text;
}

/**
 * Thread a `text_delta` into the timeline (ADR-0045), mirroring the flat-text
 * SET-vs-APPEND rule (ADR-0022) so `concatText(segments) === flat text` always holds:
 *
 * - **APPEND** (disarmed tail): extend the OPEN trailing text segment; if the trailing
 *   segment is non-text (a tool/proposal just sealed the run) or the timeline is empty,
 *   OPEN a fresh text segment — the web mirror of Core's open-on-first-delta.
 * - **SET** (armed cumulative snapshot): the delta is the cumulative concat of ALL the
 *   turn's text so far (`group_concat`, no boundary markers — `select_run_snapshot`), so
 *   it replaces EVERY existing text segment, not just the trailing one. Collapse all text
 *   segments into ONE carrying the snapshot at the position of the FIRST text segment, and
 *   drop the rest — PRESERVING the interleaved tool_call/proposal segments' order. If no
 *   text segment exists yet, OPEN one at the end. Replacing only the last text segment (the
 *   prior rule) left earlier text segments in place, so a post-park resume snapshot that
 *   re-includes pre-park prose DUPLICATED it (concatText = "A" + "A B" ≠ flat "A B").
 */
export function appendTextSegment(
	segments: readonly Segment[],
	delta: string,
	armed: boolean,
): readonly Segment[] {
	if (armed) {
		return setCumulativeText(segments, delta);
	}
	const last = segments[segments.length - 1];
	if (last?.kind === "text") {
		return [
			...segments.slice(0, -1),
			{ kind: "text", text: last.text + delta },
		];
	}
	return [...segments, { kind: "text", text: delta }];
}

/**
 * Reconcile a cumulative-snapshot SET into the timeline: the snapshot is the WHOLE
 * turn's text, so the result has exactly one text segment carrying it (at the first
 * existing text position) and keeps every non-text segment in its place. With no text
 * segment yet, the snapshot opens one at the end. This is what makes
 * `concatText(segments) === snapshot` hold even when the turn had multiple pre-snapshot
 * text runs (text→tool→text→park→resume) — the duplicated-prefix case the prior
 * last-text-only rule missed.
 */
function setCumulativeText(
	segments: readonly Segment[],
	snapshot: string,
): readonly Segment[] {
	const firstTextIndex = segments.findIndex((seg) => seg.kind === "text");
	if (firstTextIndex === -1) {
		return [...segments, { kind: "text", text: snapshot }];
	}
	const result: Segment[] = [];
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (i === firstTextIndex) {
			result.push({ kind: "text", text: snapshot });
		} else if (seg.kind !== "text") {
			result.push(seg);
		}
		// Drop every other text segment — its content is already in the snapshot.
	}
	return result;
}

/**
 * Thread a `reasoning_delta` into the timeline (ADR-0045 amendment): APPEND-ONLY,
 * the disarmed twin of {@link appendTextSegment}. There is NO armed cumulative-SET
 * path — the resume snapshot is text-only (`type='text'` SQL filter), so a reasoning
 * segment never receives a snapshot delta. If the trailing segment is `reasoning`,
 * extend its text (`opened: false`); else OPEN a fresh reasoning segment (`opened:
 * true`, the web mirror of Core's open-on-first-delta). A text/tool/proposal between
 * two reasoning runs correctly opens a new one. The `opened` flag is the single source
 * of "did a fresh block start here" — `applyEvent` uses it to (re)stamp the block's
 * open-time, rather than re-deriving the trailing-segment check separately.
 */
export interface ReasoningAppend {
	segments: readonly Segment[];
	/** Whether this delta OPENED a fresh reasoning segment (the caller stamps its
	 * open time), rather than extending the trailing one. */
	opened: boolean;
}

export function appendReasoningSegment(
	segments: readonly Segment[],
	delta: string,
): ReasoningAppend {
	const last = segments[segments.length - 1];
	if (last?.kind === "reasoning") {
		return {
			segments: [
				...segments.slice(0, -1),
				{ kind: "reasoning", text: last.text + delta },
			],
			opened: false,
		};
	}
	return {
		segments: [...segments, { kind: "reasoning", text: delta }],
		opened: true,
	};
}

/** Seal the OPEN trailing reasoning segment with a web-clocked `durationMs` when a Run
 * terminates (ADR-0045 amendment: live clocks its own open→seal). No-op if the trailing
 * segment is not reasoning, already sealed, or no open-time was recorded — the reloaded
 * path carries Core's authoritative `duration_ms`, so live is a nicety. */
export function sealOpenReasoning(
	segments: readonly Segment[],
	openedAt: number | undefined,
	now: number,
): readonly Segment[] {
	if (openedAt === undefined) {
		return segments;
	}
	const last = segments[segments.length - 1];
	if (last?.kind !== "reasoning" || last.durationMs !== undefined) {
		return segments;
	}
	return [
		...segments.slice(0, -1),
		{ kind: "reasoning", text: last.text, durationMs: now - openedAt },
	];
}

/** Upsert a `tool_call` segment by call id (ADR-0045): a new id appends a fresh
 * segment at the end of the timeline; a known id merges the terminal `status`
 * AND `result` into the existing call in place (external-task-views A4 — the
 * started row keeps its fields; the terminal event settles them). */
export function upsertToolSegment(
	segments: readonly Segment[],
	call: ToolCall,
): readonly Segment[] {
	const found = segments.some(
		(seg) => seg.kind === "tool_call" && seg.call.id === call.id,
	);
	if (!found) {
		return [...segments, { kind: "tool_call", call }];
	}
	return segments.map((seg) => {
		if (seg.kind !== "tool_call" || seg.call.id !== call.id) return seg;
		// A terminal event without a `result` must leave any prior one intact, so the
		// key rides only when the event carries it.
		const updated: ToolCall =
			call.result === undefined
				? { ...seg.call, status: call.status }
				: { ...seg.call, status: call.status, result: call.result };
		return { kind: "tool_call", call: updated };
	});
}

/** Settle any `running` tool_call SEGMENT to `terminal` when its Run ends (the
 * segment-aware twin of `settleRunningToolCalls`; the lost-boundary case). */
export function settleRunningToolSegments(
	segments: readonly Segment[],
	terminal: "completed" | "error",
): readonly Segment[] {
	return segments.map((seg) =>
		seg.kind === "tool_call" && seg.call.status === "running"
			? { kind: "tool_call", call: { ...seg.call, status: terminal } }
			: seg,
	);
}

/** Append a `proposal` segment for `runId` at the current end of the timeline,
 * unless one is already present (skip-if-present): the seam where a Proposal enters
 * the timeline (it does NOT flow through `applyEvent`) — see `setPendingProposal`. */
export function appendProposalSegment(
	segments: readonly Segment[],
	runId: string,
): readonly Segment[] {
	if (segments.some((seg) => seg.kind === "proposal")) {
		return segments;
	}
	return [...segments, { kind: "proposal", runId }];
}
