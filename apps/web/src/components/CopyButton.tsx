import { Check, Copy, X } from "lucide-react";
import { useCopyToClipboard } from "@/lib/hooks/useCopyToClipboard.js";
import { Button } from "./ui/button.js";

/** Copies `text` to the clipboard on click, swapping the Copy icon for a Check
 * while copied (or an X if the write was rejected — see {@link useCopyToClipboard}).
 * The button's `aria-label` tracks the outcome (right name on focus); the OUTCOME
 * is announced via a visually-hidden text-content live region, because `aria-live`
 * on an icon-only button does not reliably announce an aria-label change. */
export function CopyButton({ text }: { text: string }) {
	const { copied, failed, copy } = useCopyToClipboard();
	const label = copied ? "Copied" : failed ? "Couldn't copy" : "Copy";

	return (
		<Button
			variant="icon"
			size="icon"
			aria-label={label}
			onClick={() => {
				void copy(text);
			}}
		>
			{copied ? (
				<Check data-testid="copy-button-check" className="size-3.5" />
			) : failed ? (
				<X
					data-testid="copy-button-failed"
					className="size-3.5 text-destructive"
				/>
			) : (
				<Copy data-testid="copy-button-copy" className="size-3.5" />
			)}
			{/* Text-content live region so screen readers announce the outcome (an
			    aria-label change on a text-less button is not reliably announced). */}
			<span className="sr-only" role="status">
				{copied ? "Copied" : failed ? "Couldn't copy" : ""}
			</span>
		</Button>
	);
}
