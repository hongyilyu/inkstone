import { ArrowUp, Paperclip, Search, Square, X } from "lucide-react";
import {
	type ChangeEvent,
	type ClipboardEvent,
	type DragEvent,
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
	disabled = false,
}: {
	onSend: (text: string, files: File[]) => void;
	/** A Run is streaming or parked → swap Send for a Stop control. */
	isRunning?: boolean;
	/** Cancel the active Run (ADR-0014); required when `isRunning`. */
	onStop?: () => void;
	/**
	 * No LLM provider is connected → Send is gated (button disabled, Enter no-ops).
	 * The textarea stays editable so the user can still draft a message; the gate
	 * lifts the moment a provider is wired up (slice 3).
	 */
	disabled?: boolean;
}) {
	const [value, setValue] = useState("");
	// Pending image attachments (ADR-0058), paired with the object URL that backs
	// each thumbnail so remove/send can revoke exactly the URLs it minted.
	const [files, setFiles] = useState<{ file: File; url: string }[]>([]);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const addFiles = (added: File[]) => {
		const images = added.filter((f) => f.type.startsWith("image/"));
		if (images.length === 0) return;
		setFiles((prev) => [
			...prev,
			...images.map((file) => ({ file, url: URL.createObjectURL(file) })),
		]);
	};

	const removeFile = (index: number) => {
		setFiles((prev) => {
			const removed = prev[index];
			if (removed) URL.revokeObjectURL(removed.url);
			return prev.filter((_, i) => i !== index);
		});
	};

	const handlePick = (e: ChangeEvent<HTMLInputElement>) => {
		addFiles(Array.from(e.target.files ?? []));
		// Reset so re-picking the SAME file fires change again.
		e.target.value = "";
	};

	const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const images = Array.from(e.clipboardData.files).filter((f) =>
			f.type.startsWith("image/"),
		);
		if (images.length === 0) return; // plain text paste stays native
		e.preventDefault();
		addFiles(images);
	};

	const handleDrop = (e: DragEvent<HTMLFormElement>) => {
		e.preventDefault();
		addFiles(Array.from(e.dataTransfer.files));
	};

	// Auto-grow the composer with its content so a multi-line or pasted message is
	// fully visible instead of hidden in a single scrolling row. Reset to `auto`
	// first so it shrinks back when text is deleted. The growth CAP lives solely in
	// CSS (`max-h-[200px]` + `overflow-y-auto` below) — one source of truth — so we
	// set the natural content height here and let CSS clamp + scroll past it. Keyed
	// on `value` (the trigger) even though the body reads the DOM node, not the value.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resize keyed on the composed value.
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [value]);

	const submit = () => {
		// While a Run is active, Send is replaced by Stop — Enter/form-submit must
		// not fire a second turn over the live one. Stop is an explicit click only.
		if (isRunning) return;
		// No provider connected → Send is gated (covers both Enter via handleKey and
		// the form submit); the textarea stays editable so a draft isn't lost.
		if (disabled) return;
		// Text stays required even with pending files — image-only sends are out
		// of scope (kickoff decision).
		const trimmed = value.trim();
		if (!trimmed) return;
		onSend(
			trimmed,
			files.map((f) => f.file),
		);
		// The sent bubble renders from /media/{id} (bridge upload), not these
		// blobs — release them with the strip.
		for (const f of files) URL.revokeObjectURL(f.url);
		setFiles([]);
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
				onDrop={handleDrop}
				onDragOver={(e) => e.preventDefault()}
				className="cursor-text rounded-2xl border border-border bg-card p-4"
			>
				<textarea
					ref={textareaRef}
					aria-label="Message"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={handleKey}
					onPaste={handlePaste}
					rows={1}
					placeholder="Type your message here…"
					className="max-h-[200px] w-full resize-none overflow-y-auto bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
				/>
				{files.length > 0 && (
					<div className="mt-3 flex flex-wrap gap-2">
						{files.map((f, i) => (
							<div key={f.url} className="relative">
								<img
									src={f.url}
									alt={f.file.name}
									className="h-16 w-16 rounded-xl border border-secondary/50 object-cover"
								/>
								<button
									type="button"
									aria-label={`Remove ${f.file.name}`}
									onClick={() => removeFile(i)}
									className="absolute -top-1.5 -right-1.5 inline-flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
								>
									<X className="size-3" aria-hidden />
								</button>
							</div>
						))}
					</div>
				)}
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
							aria-label="Attach"
							onClick={() => fileInputRef.current?.click()}
						>
							<Paperclip className="h-4 w-4" aria-hidden />
							<span>Attach</span>
						</Button>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							multiple
							onChange={handlePick}
							className="hidden"
						/>
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
							disabled={disabled}
						>
							<ArrowUp className="h-5 w-5" aria-hidden />
						</Button>
					)}
				</div>
			</form>
		</div>
	);
}
