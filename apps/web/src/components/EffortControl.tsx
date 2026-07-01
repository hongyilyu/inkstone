import { cn } from "@/lib/utils.js";

/** The six reasoning-effort levels (ADR-0024), mirroring Core's `THINKING_LEVELS` (`off` + pi-ai's five); `off` means non-reasoning. */
export const EFFORT_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const LABELS: Record<EffortLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Max",
};

export interface EffortControlProps {
	value: string;
	onChange: (next: EffortLevel) => void;
	disabled?: boolean;
}

/** Global reasoning-effort selector — a segmented pill control. Presentational: the parent owns the value and persistence (ADR-0024). */
export function EffortControl({
	value,
	onChange,
	disabled,
}: EffortControlProps) {
	// The currently-selected index (falls back to 0 when the stored value isn't a
	// known level, e.g. pre-load) — anchors roving tabindex and arrow navigation.
	const selectedIndex = Math.max(
		0,
		EFFORT_LEVELS.indexOf(value as EffortLevel),
	);

	// WAI-ARIA radiogroup keyboard model: Left/Up → previous, Right/Down → next
	// (wrapping), Home/End → ends. Moving selection also fires onChange (a radio's
	// focus and checked state move together), matching the ARIA authoring practice.
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (disabled) return;
		const last = EFFORT_LEVELS.length - 1;
		let next = selectedIndex;
		if (e.key === "ArrowRight" || e.key === "ArrowDown")
			next = selectedIndex === last ? 0 : selectedIndex + 1;
		else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
			next = selectedIndex === 0 ? last : selectedIndex - 1;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = last;
		else return;
		e.preventDefault();
		onChange(EFFORT_LEVELS[next]);
	};

	return (
		<div
			role="radiogroup"
			aria-label="Reasoning effort"
			className="inline-flex w-full max-w-md items-center gap-0.5 rounded-lg border border-input bg-secondary/40 p-1"
		>
			{EFFORT_LEVELS.map((level, i) => {
				const active = value === level;
				return (
					// biome-ignore lint/a11y/useSemanticElements: radiogroup/radio is the correct WAI-ARIA pattern for this single-select segmented control
					<button
						key={level}
						type="button"
						role="radio"
						aria-checked={active}
						aria-label={LABELS[level]}
						disabled={disabled}
						// Roving tabindex: only the selected radio is in the tab order; the
						// group is entered with one Tab, then arrows move within it.
						tabIndex={i === selectedIndex ? 0 : -1}
						onKeyDown={onKeyDown}
						onClick={() => onChange(level)}
						className={cn(
							"flex-1 cursor-pointer rounded-md px-2.5 py-1.5 text-center font-medium text-xs transition-all disabled:cursor-not-allowed disabled:opacity-50",
							active
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{LABELS[level]}
					</button>
				);
			})}
		</div>
	);
}
