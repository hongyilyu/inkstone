import { ChevronDown, Paperclip, Search, Send, Zap } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { currentRun } from "../data/mock.js";
import { Button } from "./ui/button.js";

export function ComposeFooter({ onSend }: { onSend: (text: string) => void }) {
	const [value, setValue] = useState("");

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

	return (
		<form
			onSubmit={handleSubmit}
			className="relative rounded-t-[20px] bg-chat-input-bg p-2 pb-0 backdrop-blur-lg before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-[linear-gradient(90deg,transparent,var(--chat-input-gradient),transparent)] before:content-['']"
		>
			<textarea
				aria-label="Message"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={handleKey}
				rows={2}
				placeholder="Message"
				className="w-full resize-none bg-transparent px-2 py-2 text-base text-foreground outline-none placeholder:text-secondary-foreground/60"
			/>
			<div className="flex items-center justify-between gap-2 px-2 pb-2">
				<div className="flex items-center gap-1.5 text-xs">
					<ChipButton>
						<span>{currentRun.model}</span>
						<ChevronDown className="h-3 w-3" aria-hidden />
					</ChipButton>
					<ChipButton>
						<Zap className="h-3 w-3" aria-hidden />
						<span>Instant</span>
					</ChipButton>
					<ChipButton>
						<Search className="h-3 w-3" aria-hidden />
						<span>Search</span>
					</ChipButton>
					<ChipButton>
						<Paperclip className="h-3 w-3" aria-hidden />
						<span>Attach</span>
					</ChipButton>
					<span className="ml-1 hidden text-foreground/40 lg:inline">
						{currentRun.tokens.toLocaleString("en-US")} tokens
					</span>
				</div>
				<Button
					type="submit"
					aria-label="Send"
					variant="primary-icon"
					size="icon-lg"
				>
					<Send className="h-4 w-4 text-pink-50" />
				</Button>
			</div>
		</form>
	);
}

function ChipButton({ children }: { children: React.ReactNode }) {
	return (
		<Button variant="chip" size="sm">
			{children}
		</Button>
	);
}
