import { Popover } from "@base-ui-components/react/popover";
import { ChevronDown, Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import { useRuntime } from "@/runtime";
import { fetchSettings, saveSettings } from "@/store/settings";
import { EffortControl, type EffortLevel } from "./EffortControl.js";
import { Button } from "./ui/button.js";

const LABELS: Record<EffortLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Max",
};

/**
 * Composer reasoning-effort control. Reflects the real global `effort`
 * (`settings/get`) and persists a change via `settings/set` — the same setting
 * the settings page drives (ADR-0024). The trigger chip shows the current
 * level; the popover reuses {@link EffortControl}.
 */
export function EffortPicker() {
	const runtime = useRuntime();
	const [effort, setEffort] = useState<string>("off");
	const [open, setOpen] = useState(false);

	useEffect(() => {
		let alive = true;
		fetchSettings(runtime)
			.then((s) => {
				if (alive) setEffort(s.effort);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [runtime]);

	const change = (next: EffortLevel) => {
		setEffort(next); // optimistic
		saveSettings(runtime, { effort: next })
			.then((s) => setEffort(s.effort))
			.catch(() => {});
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				render={
					<Button variant="chip" size="pill" aria-label="Reasoning effort">
						<Gauge className="h-4 w-4" aria-hidden />
						<span>{LABELS[effort as EffortLevel] ?? "Effort"}</span>
						<ChevronDown className="h-4 w-4" aria-hidden />
					</Button>
				}
			/>
			<Popover.Portal>
				<Popover.Positioner side="top" align="start" sideOffset={8}>
					<Popover.Popup className="flex w-[320px] flex-col gap-2 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none">
						<div className="font-medium text-sm">Reasoning effort</div>
						<EffortControl value={effort} onChange={change} />
						<p className="text-muted-foreground text-xs">
							Higher effort thinks longer before replying. Applies to new
							messages.
						</p>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
