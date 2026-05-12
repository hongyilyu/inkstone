/**
 * Per-session prompt-draft bridge.
 *
 * Mounts as a sibling of `<Conversation />` inside the conversation-view
 * branch of `app.tsx` (above the `<Show>` chain that gates the bottom
 * panel). Owns the lifetime of `usePromptDraft` so the hook's
 * `sessionId` accessor is non-nullable: by the time this bridge mounts,
 * `messages.length > 0` is true and `ensureSession()` has run, so the
 * sessionId has a real value.
 *
 * Why this is a separate component from `<Prompt />`:
 *   - `<Prompt />` is reused on the open page (no session bound) and
 *     the conversation view (session bound). Hosting the draft hook
 *     there forced the hook's `sessionId` accessor to be `string | null`
 *     and required `if (sid === null) return` short-circuits — patching
 *     over the fact that the hook was attached to the wrong component.
 *   - This bridge mounts only in the conversation branch, where session
 *     identity is structurally guaranteed. The hook becomes contract-
 *     clean: `sessionId: () => string`.
 *   - The bridge survives the inner `<Show>` chain that toggles between
 *     Prompt and the permission/suggestion/disconnect panels. Today the
 *     in-Prompt hook would snapshot/restore on every panel toggle,
 *     wasted work; the bridge mounts once per conversation-view
 *     lifetime and snapshots only at real navigation boundaries
 *     (secondary-page open, clearSession, resumeSession to a different
 *     sid).
 *
 * Reactive sources:
 *   - `inputRef` via `useLayout().getInputRef()`. The layout's input is
 *     signal-backed (see `layout.tsx`), so reading the getter inside an
 *     effect tracks Prompt's mount/unmount cycle. The bridge mirrors
 *     the latest value plus the just-registered `prompt-mention`
 *     typeId into local signals it passes to the hook.
 *   - `sessionId` via `useAgent().session.subscribeSessionId()` — the
 *     reactive accessor on `SessionState`. Resume swapping the id
 *     underneath this bridge is what the hook's switch-handler
 *     depends on.
 *   - `fileStyleId` via `useTheme().syntax().getStyleId("extmark.file")`.
 *     The hook reads it untracked at apply time so theme switches
 *     don't stomp the live buffer with a stored draft.
 *
 * `extmarks.registerType("prompt-mention")` is idempotent per name,
 * so re-registering it from the bridge after Prompt already registered
 * it returns the same id — no collision with mention spans Prompt
 * creates.
 */

import type { TextareaRenderable } from "@opentui/core";
import { createEffect, createSignal } from "solid-js";
import { useAgent } from "../context/agent";
import { useLayout } from "../context/layout";
import { useTheme } from "../context/theme";
import { usePromptDraft } from "../hooks/use-prompt-draft";

export function PromptDraftBridge() {
	const layout = useLayout();
	const { syntax } = useTheme();
	const { session } = useAgent();
	const sessionIdAccessor = session.subscribeSessionId();

	// Both signals start `null` / `0` because the bridge sets up
	// before Prompt's textarea ref callback fires; the effect below
	// flips them to live values on its first run after the ref lands.
	const [inputRef, setInputRef] = createSignal<TextareaRenderable | null>(null);
	const [typeId, setTypeId] = createSignal(0);

	// Track the layout's signal-backed input. Re-runs whenever Prompt
	// mounts/unmounts. When the input is alive, register the mention
	// typeId (idempotent per name) and publish both into local signals
	// that the hook subscribes to.
	createEffect(() => {
		const live = layout.getInputRef();
		if (live && !live.isDestroyed) {
			setInputRef(live);
			setTypeId(live.extmarks.registerType("prompt-mention"));
		} else {
			setInputRef(null);
			setTypeId(0);
		}
	});

	usePromptDraft({
		// `inputRef` from a `createSignal<TextareaRenderable | null>` —
		// the hook accepts `() => TextareaRenderable | undefined`, so a
		// `null` accessor satisfies it (the gate `!input` covers both).
		inputRef: () => inputRef() ?? undefined,
		promptPartTypeId: typeId,
		fileStyleId: () => syntax().getStyleId("extmark.file") ?? null,
		// Non-null by construction. Two paths arrive here with a real
		// session id:
		//   - Fresh conversation: `promptAction` calls `ensureSession`
		//     before appending the user bubble, so the SQLite row exists
		//     by the time `messages.length > 0` flips true and the
		//     bridge's outer `<Show>` mounts this component.
		//   - Resume: `resumeSession` runs inside a Solid `batch()` that
		//     calls `setCurrentSessionId(loaded.session.id)` (resume.ts:61)
		//     BEFORE `setStore("messages", loaded.displayMessages)`
		//     (resume.ts:71). When the batch flushes, the session signal
		//     is already non-null when the messages-bound `<Show>`
		//     re-evaluates and the bridge mounts.
		// Reordering those two writes in `resume.ts` would break this
		// invariant — leave a tripwire there if you touch that batch.
		sessionId: () => sessionIdAccessor() as string,
		// `syncText` deliberately omitted. The textarea's `setText`
		// emits `content-changed` synchronously (verified in
		// `@opentui/core/index-s460mpf9.js`'s ExtmarksController), and
		// Prompt's `onContentChange` handler updates its `text` signal.
		// So Prompt's slash-coaching memo + autocomplete state stay
		// coherent without an explicit nudge from the bridge.
	});

	return null;
}
