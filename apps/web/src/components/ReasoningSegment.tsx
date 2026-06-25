import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils.js";

/**
 * The model's thinking trace as a calm, default-collapsed disclosure (ADR-0045
 * amendment, #202). Visually subordinate to the reply — a muted, thin-bordered
 * row that never competes with the answer or the approval. Deliberately stays
 * collapsed while streaming (no auto-expand): expanding mid-stream reflows the
 * layout and shoves the Proposal down at the decision moment.
 *
 * Label: "Thinking…" while this reasoning is still open and its turn is streaming;
 * once sealed, `Thought for Ns` (`durationMs >= 1000`, rounded to whole seconds)
 * or a bare "Thought" (sub-second or unknown). The expand transition gates behind
 * `motion-safe:` — the repo's reduced-motion convention (instant toggle by default).
 */
export function ReasoningSegment({
	text,
	durationMs,
	streaming,
}: {
	readonly text: string;
	/** Web-clocked (live) or Core-computed (reload) thinking duration; absent while open or sub-second-unknown. */
	readonly durationMs?: number;
	/** This reasoning is still open on a streaming turn → the live "Thinking…" label. */
	readonly streaming: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	// "Open" = still thinking: a streaming turn with no sealed duration yet. Drives both
	// the live "Thinking…" label and its pulse, so a block sealed mid-stream (duration
	// set while later text streams) reads a calm settled "Thought for Ns", never a
	// pulsing one.
	const open = streaming && durationMs === undefined;
	const label = reasoningLabel(open, durationMs);
	return (
		<div className="w-full border-secondary border-l pl-3 text-muted-foreground text-sm">
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-left focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
			>
				<ChevronRight
					aria-hidden
					className={cn(
						"size-3.5 shrink-0 motion-safe:transition-transform",
						expanded && "rotate-90",
					)}
				/>
				<span className={cn(open && "motion-safe:animate-pulse")}>{label}</span>
			</button>
			{expanded && (
				<p className="whitespace-pre-wrap py-1 pl-5 text-muted-foreground/90">
					{text}
				</p>
			)}
		</div>
	);
}

/** "Thinking…" while the block is still open, else `Thought for Ns` (≥1s) or a bare "Thought". */
function reasoningLabel(open: boolean, durationMs?: number): string {
	if (open) return "Thinking…";
	return durationMs !== undefined && durationMs >= 1000
		? `Thought for ${Math.round(durationMs / 1000)}s`
		: "Thought";
}
