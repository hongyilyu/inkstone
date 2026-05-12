/**
 * Prompt-draft snapshot/restore hook.
 *
 * Owns the lifecycle for the per-session draft slot defined in
 * `src/tui/context/prompt-draft.ts`. The bridge component
 * (`src/tui/components/prompt-draft-bridge.tsx`) calls this hook with
 * a non-nullable `sessionId` accessor — bridges only mount inside the
 * conversation-view branch of `app.tsx`, where `ensureSession()` has
 * already run and the session id is guaranteed to be a real string.
 * Hosting the hook there (instead of inside the shared `<Prompt />`
 * component, which is also reused on the open page where no session
 * exists) is what lets this signature be non-nullable.
 *
 * Three transitions are covered:
 *
 *   1. **Restore on mount** — once `inputRef` and `promptPartTypeId`
 *      are both ready, read the slot for the current sessionId and
 *      replay text + mentions into the textarea.
 *
 *   2. **Snapshot on session-switch (while mounted)** — when
 *      `sessionId` changes from `prev → next`, write the live textarea
 *      state to slot `prev`, then restore from slot `next` (or clear
 *      the buffer if `next` has no slot). `resumeSession` triggers
 *      this case: it mutates the id underneath the bridge without
 *      unmounting it.
 *
 *   3. **Snapshot on unmount** — `onCleanup` writes the live state to
 *      the current slot. This is the secondary-page round-trip
 *      surface: opening a secondary page tears down the entire
 *      conversation-view subtree (bridge included), and the next
 *      mount reads from the slot we wrote here. The `lastSeenSid`
 *      closure-tracked field is the snapshot key, NOT the live
 *      `sessionId()` read at cleanup time — Solid's batch-internal
 *      ordering between `setStore("messages", [])` and
 *      `setCurrentSessionId(null)` during `clearSession` is not a
 *      contract we want to depend on.
 *
 * Submit-clear is NOT this hook's concern. `Prompt.clearInput()` calls
 * `clearDraft(sessionId)` directly because submit doesn't unmount the
 * component (so `onCleanup` wouldn't fire) and routing the clear
 * through the hook would require an extra signal for "submit happened"
 * with no other consumers.
 *
 * Routing-fork case: when the router dispatches a freeform open-page
 * message into a child session (`applyDispatchResult` → `forkSession`
 * → `resumeSession(child)`), the child's slot is empty by
 * construction — it was just created. The hook clears the live
 * buffer and finds nothing to restore, which is the right behavior:
 * the child's first turn is seeded by the fork itself, not by user
 * typing.
 */

import type { TextareaRenderable } from "@opentui/core";
import { createEffect, onCleanup, untrack } from "solid-js";
import {
	clearDraft,
	type Draft,
	getDraft,
	setDraft,
} from "../context/prompt-draft";

export interface UsePromptDraftDeps {
	/** Live textarea handle. `null` until the ref callback fires. */
	inputRef: () => TextareaRenderable | undefined;
	/**
	 * Numeric extmark type id for prompt mentions. `0` until the
	 * Prompt's ref callback registers the type. The hook waits for a
	 * non-zero value before doing any extmark work.
	 */
	promptPartTypeId: () => number;
	/**
	 * Current `extmark.file` style id resolved against the active
	 * theme. Re-stamped onto restored mentions so the file-style
	 * highlight survives the roundtrip even across theme changes.
	 */
	fileStyleId: () => number | null;
	/**
	 * Reactive session id. Non-nullable by contract: bridges only
	 * mount inside the conversation-view branch of `app.tsx` where
	 * `ensureSession` has already run. Open-page Prompts never mount
	 * a bridge, so this hook never sees `null`.
	 */
	sessionId: () => string;
	/**
	 * Optional: nudge an external `text` signal after a restore writes
	 * new content into the textarea. The textarea's `setText` emits
	 * `content-changed` synchronously (verified in OpenTUI core), and
	 * `<Prompt />` already subscribes via `onContentChange` to keep its
	 * `text` signal in sync — so callers driven by Prompt's natural
	 * content-change wiring can omit this. Reserved for callers that
	 * own a parallel buffer-mirror signal independent of Prompt.
	 */
	syncText?: (text: string) => void;
}

function snapshotDraft(
	input: TextareaRenderable,
	promptPartTypeId: number,
): Draft {
	const text = input.plainText;
	if (promptPartTypeId === 0) return { text, mentions: [] };
	const mentions = input.extmarks
		.getAllForTypeId(promptPartTypeId)
		.map((mark) => {
			const meta = input.extmarks.getMetadataFor(mark.id);
			const path = meta?.path;
			if (typeof path !== "string") return null;
			return { start: mark.start, end: mark.end, path };
		})
		.filter(
			(m): m is { start: number; end: number; path: string } => m !== null,
		)
		.sort((a, b) => a.start - b.start);
	return { text, mentions };
}

function applyDraft(
	input: TextareaRenderable,
	draft: Draft,
	promptPartTypeId: number,
	fileStyleId: number | null,
): void {
	// `setText` clears all extmarks via `ExtmarksController.wrapSetText`,
	// which is what we want — restoring from a slot replaces, not
	// merges. The mentions are then replayed below.
	input.setText(draft.text);
	if (promptPartTypeId === 0) return;
	for (const m of draft.mentions) {
		input.extmarks.create({
			start: m.start,
			end: m.end,
			virtual: true,
			styleId: fileStyleId ?? undefined,
			typeId: promptPartTypeId,
			metadata: { path: m.path },
		});
	}
}

function clearBuffer(input: TextareaRenderable): void {
	input.setText("");
}

export function usePromptDraft(deps: UsePromptDraftDeps): void {
	// Tracks the sessionId we last restored from / snapshotted to, so
	// the switch effect can snapshot the *previous* slot before
	// hydrating from the next one. Starts at `undefined` so the first
	// effect run performs a pure restore (no snapshot of the empty
	// initial buffer over the slot we're about to read from).
	let lastSeenSid: string | undefined;

	// Mount + switch handler. Re-runs on changes to `inputRef`,
	// `promptPartTypeId`, or `sessionId`. The first run that satisfies
	// all gates does a restore; subsequent sid changes do snapshot-
	// then-restore.
	createEffect(() => {
		const input = deps.inputRef();
		const typeId = deps.promptPartTypeId();
		const sid = deps.sessionId();
		if (!input || input.isDestroyed) return;
		if (typeId === 0) return;

		// Snapshot the previous session's draft before swapping. Skip
		// on the very first run (lastSeenSid === undefined) — that's a
		// pure mount, not a switch, and snapshotting the (empty)
		// initial buffer would clobber any restore we're about to do.
		if (lastSeenSid !== undefined && lastSeenSid !== sid) {
			const snap = snapshotDraft(input, typeId);
			if (snap.text.length === 0 && snap.mentions.length === 0) {
				// An empty buffer is the same as "no draft" — drop
				// the slot rather than parking an empty placeholder
				// that would round-trip as a no-op.
				clearDraft(lastSeenSid);
			} else {
				setDraft(lastSeenSid, snap);
			}
			// Wipe the live buffer before restoring the next slot.
			// Without this, switching from session A (with text) to
			// session B (no slot) would leave A's text on screen
			// because `applyDraft` short-circuits past `setText("")`
			// when there's nothing to apply.
			clearBuffer(input);
			deps.syncText?.("");
		}

		// `getDraft` reads the module-level `drafts` signal. Without
		// `untrack`, Solid registers it as a dependency of this
		// effect, and our own `setDraft`/`clearDraft` writes above
		// would re-trigger the effect. The slot is intentionally
		// re-read only when `sid` changes, never when another
		// session's slot mutates.
		const draft = untrack(() => getDraft(sid));
		if (draft) {
			// `fileStyleId` is a memo over the theme. Reading it
			// untracked keeps a theme switch from re-running this
			// effect and stomping the live buffer with the stored
			// draft. Newly-restored mentions still pick up the
			// current styleId at apply time.
			const styleId = untrack(() => deps.fileStyleId());
			applyDraft(input, draft, typeId, styleId);
			deps.syncText?.(draft.text);
		}

		lastSeenSid = sid;
	});

	// Snapshot on unmount — the secondary-page round-trip + clearSession
	// surface. We snapshot against `lastSeenSid`, not the live
	// `sessionId()` accessor: `clearSession` writes
	// `setCurrentSessionId(null)` and `setStore("messages", [])` inside
	// the same `batch()`, and the bridge unmounts because messages.length
	// flips to 0. We don't want to depend on Solid's batch-internal
	// ordering (whether the unmount sees the pre-null or post-null sid).
	// `lastSeenSid` is captured on every successful restore and
	// represents "the sid this draft belongs to," independent of the
	// store's mid-batch state.
	onCleanup(() => {
		// `onCleanup` runs synchronously when the owner scope is
		// disposed; it is NOT inside a reactive context, so these
		// `deps.*()` calls are non-tracking reads even though they
		// look like the same accessor reads inside the effect above.
		const input = deps.inputRef();
		const typeId = deps.promptPartTypeId();
		if (!input || input.isDestroyed) return;
		if (typeId === 0) return;
		if (lastSeenSid === undefined) return;
		const snap = snapshotDraft(input, typeId);
		if (snap.text.length === 0 && snap.mentions.length === 0) {
			clearDraft(lastSeenSid);
		} else {
			setDraft(lastSeenSid, snap);
		}
	});
}
