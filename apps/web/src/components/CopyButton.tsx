import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/lib/hooks/useCopyToClipboard.js";
import { Button } from "./ui/button.js";

/** Copies `text` to the clipboard on click, swapping the Copy icon for a Check while copied (see {@link useCopyToClipboard}). */
export function CopyButton({ text }: { text: string }) {
	const { copied, copy } = useCopyToClipboard();

	return (
		<Button
			variant="icon"
			size="icon"
			aria-label="Copy"
			onClick={() => {
				void copy(text);
			}}
		>
			{copied ? (
				<Check data-testid="copy-button-check" className="size-3.5" />
			) : (
				<Copy data-testid="copy-button-copy" className="size-3.5" />
			)}
		</Button>
	);
}
