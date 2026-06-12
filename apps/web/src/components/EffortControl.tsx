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
	return (
		<div
			role="radiogroup"
			aria-label="Reasoning effort"
			className="inline-flex w-full max-w-md items-center gap-0.5 rounded-lg border border-input bg-secondary/40 p-1"
		>
			{EFFORT_LEVELS.map((level) => {
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
