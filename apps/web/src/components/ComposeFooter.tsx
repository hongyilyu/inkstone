import { ArrowUp, ChevronDown, Paperclip, Search, Zap } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type MouseEvent,
	useRef,
	useState,
} from "react";
import { currentRun } from "../data/mock.js";
import { Button } from "./ui/button.js";

export function ComposeFooter({ onSend }: { onSend: (text: string) => void }) {
	const [value, setValue] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const submit = () => {
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
		// Only steal focus when the click hits the form chrome itself, not a
		// nested interactive element (chips, send button).
		if (e.target === e.currentTarget) {
			textareaRef.current?.focus();
		}
	};

	return (
		<div className="px-4 pt-2 pb-4">
			<form
				onSubmit={handleSubmit}
				onClick={focusTextarea}
				className="cursor-text rounded-2xl border border-border bg-card/40 p-4 backdrop-blur-lg"
			>
				<textarea
					ref={textareaRef}
					aria-label="Message"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={handleKey}
					rows={1}
					placeholder="Type your message here…"
					className="w-full resize-none bg-transparent text-base text-foreground outline-none placeholder:text-foreground/40"
				/>
				<div className="mt-3 flex items-end justify-between gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="chip" size="pill">
							<span>{currentRun.model}</span>
							<ChevronDown className="h-4 w-4" aria-hidden />
						</Button>
						<Button variant="chip" size="pill">
							<Zap className="h-4 w-4" aria-hidden />
							<span>Instant</span>
						</Button>
						<Button variant="chip" size="pill">
							<Search className="h-4 w-4" aria-hidden />
							<span>Search</span>
						</Button>
						<Button variant="chip" size="pill">
							<Paperclip className="h-4 w-4" aria-hidden />
							<span>Attach</span>
						</Button>
						<span className="ml-1 hidden text-xs text-foreground/40 lg:inline">
							{currentRun.tokens.toLocaleString("en-US")} tokens
						</span>
					</div>
					<Button
						type="submit"
						aria-label="Send"
						variant="primary-icon"
						size="icon-lg"
					>
						<ArrowUp className="h-5 w-5" aria-hidden />
					</Button>
				</div>
			</form>
		</div>
	);
}
