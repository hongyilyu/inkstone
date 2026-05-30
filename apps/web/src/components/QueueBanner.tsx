// VISUAL ONLY — "question" queue items are not yet defined in the protocol; rendered as placeholder per /8.
import { useEffect, useState } from "react";
import { queue } from "../data/mock.js";
import { cn } from "../lib/utils.js";

const LEAVE_MS = 220;
const ENTER_DELAY_MS = 80;

type Phase = "idle" | "leaving" | "entering";

export function QueueBanner() {
	const [currentIdx, setCurrentIdx] = useState(0);
	const [phase, setPhase] = useState<Phase>("idle");

	const advance = () => {
		if (phase !== "idle") return;
		if (currentIdx >= queue.length) return;
		setPhase("leaving");
		setTimeout(() => {
			setCurrentIdx((i) => i + 1);
			setPhase("entering");
			setTimeout(() => setPhase("idle"), ENTER_DELAY_MS);
		}, LEAVE_MS);
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "1" || e.ctrlKey || e.metaKey || e.altKey) return;
			advance();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- advance reads stable state via setters
	}, [phase, currentIdx]);

	if (currentIdx >= queue.length) return null;
	const item = queue[currentIdx];

	return (
		<div
			data-phase={phase}
			className={cn(
				"flex items-center gap-2 border-b border-border bg-card px-3 py-2 text-sm text-card-foreground transition-opacity",
				phase === "leaving" && "opacity-0",
				phase === "entering" && "opacity-100",
			)}
		>
			<span
				aria-hidden
				className="text-muted-foreground"
			>
				{item.pendingGlyph}
			</span>
			<span className="flex-1">{item.pendingTitle}</span>
			<button
				type="button"
				onClick={advance}
				className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
			>
				{item.kind === "approval" ? "Approve (1)" : "Answer (1)"}
			</button>
		</div>
	);
}
