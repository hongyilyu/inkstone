import { Send } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { currentRun } from "../data/mock.js";

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
			<div className="flex items-center justify-between px-2 pb-2 text-xs text-muted-foreground">
				<span>
					{currentRun.model} · {currentRun.tokens.toLocaleString("en-US")} tokens
				</span>
				<button
					type="submit"
					aria-label="Send"
					className="inline-flex h-[45px] w-[45px] items-center justify-center rounded-lg bg-primary/20 text-primary-foreground shadow-sm transition-colors hover:bg-primary"
				>
					<Send className="h-4 w-4 text-pink-50" />
				</button>
			</div>
		</form>
	);
}
