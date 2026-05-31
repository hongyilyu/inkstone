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
			className="flex flex-col gap-2 border-t border-border bg-background p-3"
		>
			<textarea
				aria-label="Message"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={handleKey}
				rows={2}
				placeholder="Message"
				className="resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
			/>
			<div className="flex items-center justify-between text-xs text-muted-foreground">
				<span>
					{currentRun.model} · {currentRun.tokens.toLocaleString("en-US")} tokens
				</span>
				<button
					type="submit"
					className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
				>
					<Send className="h-3.5 w-3.5" />
					Send
				</button>
			</div>
		</form>
	);
}
