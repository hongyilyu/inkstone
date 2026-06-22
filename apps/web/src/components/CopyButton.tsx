import { useCopyToClipboard } from "@/lib/hooks/useCopyToClipboard.js";
import { CopyOutcome, copyLabel } from "./CopyOutcome.js";
import { Button } from "./ui/button.js";

/** Copies `text` to the clipboard on click. The icon swap + screen-reader
 * announcement live in {@link CopyOutcome} (shared with the sidebar copy button);
 * the button's `aria-label` tracks the outcome for the right name on focus. */
export function CopyButton({ text }: { text: string }) {
	const { copied, failed, copy } = useCopyToClipboard();

	return (
		<Button
			variant="icon"
			size="icon"
			aria-label={copyLabel(copied, failed)}
			onClick={() => {
				void copy(text);
			}}
		>
			<CopyOutcome copied={copied} failed={failed} testIdPrefix="copy-button" />
		</Button>
	);
}
