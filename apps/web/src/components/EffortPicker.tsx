import { Popover } from "@base-ui-components/react/popover";
import { ChevronDown, Gauge } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useOptimisticSetting } from "@/lib/hooks/useOptimisticSetting";
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

/** Composer reasoning-effort control. Reflects the global `effort` (`settings/get`) and persists changes via `settings/set` (ADR-0024); popover reuses {@link EffortControl}. */
export function EffortPicker() {
	const runtime = useRuntime();
	const [open, setOpen] = useState(false);
	// Same optimistic/latest-write-wins/rollback machinery as the Settings page —
	// this writes the SAME global `effort`, so it must not race differently
	// (useOptimisticSetting). Starts `null` so the chip shows the neutral "Effort"
	// label rather than mislabeling as "Off" before `settings/get` resolves.
	const effort = useOptimisticSetting<string | null>(
		null,
		useCallback(
			(next) =>
				saveSettings(runtime, { effort: next ?? undefined }).then(
					(s) => s.effort,
				),
			[runtime],
		),
	);

	const { seed } = effort;
	useEffect(() => {
		let alive = true;
		fetchSettings(runtime)
			.then((s) => {
				if (alive) seed(s.effort);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [runtime, seed]);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				render={
					<Button variant="chip" size="pill" aria-label="Reasoning effort">
						<Gauge className="h-4 w-4" aria-hidden />
						<span>{LABELS[effort.value as EffortLevel] ?? "Effort"}</span>
						<ChevronDown className="h-4 w-4" aria-hidden />
					</Button>
				}
			/>
			<Popover.Portal>
				<Popover.Positioner side="top" align="start" sideOffset={8}>
					<Popover.Popup className="flex w-[360px] flex-col gap-2 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none">
						<div className="font-medium text-sm">Reasoning effort</div>
						<EffortControl
							value={effort.value ?? "off"}
							onChange={effort.set}
						/>
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
