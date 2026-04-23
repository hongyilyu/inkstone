import { type InputRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import {
	createEffect,
	createSignal,
	type JSX,
	on,
	onMount,
	Show,
} from "solid-js";
import { useTheme } from "../context/theme";
import * as Keybind from "../util/keybind";
import { type DialogContext, useDialog } from "./dialog";

/**
 * Single-line prompt dialog.
 *
 * Ported from OpenCode's `ui/dialog-prompt.tsx` (trimmed — no busy state,
 * no textarea multiline, no suspend traits). Uses `<input>` to match
 * `DialogSelect`'s existing widget choice, so an `InputRenderable`'s
 * `onInput`/`onSubmit` are the source of truth.
 *
 * `DialogPrompt.show(dialog, { title, ... })` returns a promise resolving
 * to the submitted string or `null` on cancel — mirrors OpenCode's helper.
 *
 * Note on overlapping prompts: `DialogPrompt.show` uses `dialog.replace`,
 * which fires the previous dialog's `onClose` before mounting the
 * replacement. In practice this means any in-flight prompt silently
 * resolves to `null` when another prompt (or any other dialog) replaces
 * it. Callers that `await DialogPrompt.show(...)` sequentially — like
 * the Kiro login flow — are unaffected; overlapping calls would need
 * their own queueing.
 */
export interface DialogPromptProps {
	title: string;
	description?: () => JSX.Element;
	placeholder?: string;
	allowEmpty?: boolean;
	value?: string;
	onConfirm?: (value: string) => void;
	onCancel?: () => void;
}

export function DialogPrompt(props: DialogPromptProps) {
	const dialog = useDialog();
	const { theme } = useTheme();
	let input: InputRenderable | undefined;

	// Track the current input text as a signal. Initialized from
	// `props.value` and re-synced when the prop changes so a parent that
	// re-mounts this component with a different default value doesn't
	// end up submitting stale text (submit reads from `currentValue()`).
	const [currentValue, setCurrentValue] = createSignal(props.value ?? "");
	createEffect(
		on(
			() => props.value,
			(v) => {
				setCurrentValue(v ?? "");
			},
			{ defer: true },
		),
	);

	function submit() {
		const v = currentValue();
		if (!props.allowEmpty && v.trim().length === 0) return;
		props.onConfirm?.(v);
	}

	// Enter submits. ESC falls through to the dialog provider (`dialog_close`)
	// which fires the registered `onClose` — set up by `.show` below to
	// resolve the promise with `null`.
	useKeyboard((evt: any) => {
		if (evt.defaultPrevented) return;
		if (Keybind.match("select_submit", evt)) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			submit();
		}
	});

	onMount(() => {
		setTimeout(() => {
			if (!input || input.isDestroyed) return;
			input.focus();
		}, 1);
	});

	return (
		<box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
			<box flexDirection="row" justifyContent="space-between">
				<text attributes={TextAttributes.BOLD} fg={theme.text}>
					{props.title}
				</text>
				<text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
					esc
				</text>
			</box>
			<Show when={props.description}>
				<box>{props.description?.()}</box>
			</Show>
			<input
				onInput={(e: string) => {
					setCurrentValue(e);
				}}
				onSubmit={() => submit()}
				ref={(r: InputRenderable) => {
					input = r;
				}}
				value={props.value}
				placeholder={props.placeholder ?? "Enter text"}
				placeholderColor={theme.textMuted}
				backgroundColor={theme.backgroundPanel}
				focusedBackgroundColor={theme.backgroundPanel}
				textColor={theme.text}
				focusedTextColor={theme.text}
				cursorColor={theme.primary}
			/>
			<text fg={theme.text}>
				enter <span style={{ fg: theme.textMuted }}>submit</span>
			</text>
		</box>
	);
}

DialogPrompt.show = (
	dialog: DialogContext,
	props: Omit<DialogPromptProps, "onConfirm" | "onCancel">,
): Promise<string | null> =>
	new Promise((resolve) => {
		dialog.replace(
			() => (
				<DialogPrompt
					{...props}
					onConfirm={(value) => {
						resolve(value);
						dialog.clear();
					}}
					onCancel={() => resolve(null)}
				/>
			),
			() => resolve(null),
		);
	});
