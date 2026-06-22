import { ArrowUp, Paperclip, Search, Square } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type MouseEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { EffortPicker } from "./EffortPicker.js";
import { ModelPicker } from "./ModelPicker.js";
import { Button } from "./ui/button.js";

export function ComposeFooter({
	onSend,
	isRunning = false,
	onStop,
}: {
	onSend: (text: string) => void;
	/** A Run is streaming or parked → swap Send for a Stop control. */
	isRunning?: boolean;
	/** Cancel the active Run (ADR-0014); required when `isRunning`. */
	onStop?: () => void;
}) {
	const [value, setValue] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Auto-grow the composer with its content (up to a cap) so a multi-line or
	// pasted message is fully visible instead of hidden in a single scrolling row.
	// Reset to `auto` first so it shrinks back when text is deleted. Keyed on
	// `value` (the trigger) even though the body reads the DOM node, not the value.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resize keyed on the composed value.
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}, [value]);

	const submit = () => {
		// While a Run is active, Send is replaced by Stop — Enter/form-submit must
		// not fire a second turn over the live one. Stop is an explicit click only.
		if (isRunning) return;
		const trimmed = value.trim();
		if (!trimmed) return;
		onSend(trimmed);
		setValue("");
	};

	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		submit();
	};

	const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	};

	const focusTextarea = (e: MouseEvent<HTMLFormElement>) => {
		// Only steal focus when the click hits the form chrome, not a nested control.
		if (e.target === e.currentTarget) {
			textareaRef.current?.focus();
		}
	};

	return (
		<div className="px-4 pt-2 pb-4">
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: clicking the composer chrome forwards focus to the textarea; keyboard users tab straight to it, so there is no keyboard analog */}
			<form
				onSubmit={handleSubmit}
				onClick={focusTextarea}
				className="cursor-text rounded-2xl border border-border bg-card p-4"
			>
				<textarea
					ref={textareaRef}
					aria-label="Message"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={handleKey}
					rows={1}
					placeholder="Type your message here…"
					className="max-h-[200px] w-full resize-none overflow-y-auto bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
				/>
				<div className="mt-3 flex items-end justify-between gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<ModelPicker />
						<EffortPicker />
						<Button
							variant="chip"
							size="pill"
							disabled
							aria-label="Search (coming soon)"
							title="Web search isn't available yet"
						>
							<Search className="h-4 w-4" aria-hidden />
							<span>Search</span>
						</Button>
						<Button
							variant="chip"
							size="pill"
							disabled
							aria-label="Attach (coming soon)"
							title="Attachments aren't available yet"
						>
							<Paperclip className="h-4 w-4" aria-hidden />
							<span>Attach</span>
						</Button>
					</div>
					{isRunning ? (
						<Button
							type="button"
							aria-label="Stop"
							variant="primary-icon"
							size="icon-lg"
							onClick={onStop}
						>
							<Square className="h-4 w-4 fill-current" aria-hidden />
						</Button>
					) : (
						<Button
							type="submit"
							aria-label="Send"
							variant="primary-icon"
							size="icon-lg"
						>
							<ArrowUp className="h-5 w-5" aria-hidden />
						</Button>
					)}
				</div>
			</form>
		</div>
	);
}
