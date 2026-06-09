import { PanelRightClose, PanelRightOpen, Settings2 } from "lucide-react";
import { Button } from "./ui/button.js";

export interface TopRightControlsProps {
	onOpenSettings?: () => void;
	onToggleRail?: () => void;
	railCollapsed?: boolean;
}

export function TopRightControls({
	onOpenSettings,
	onToggleRail,
	railCollapsed = false,
}: TopRightControlsProps = {}) {
	return (
		<div className="flex items-center gap-1 px-2 py-1 text-sm">
			<Button
				variant="icon"
				size="icon"
				aria-label="Settings"
				onClick={onOpenSettings}
			>
				<Settings2 className="h-3.5 w-3.5" aria-hidden />
			</Button>
			<Button
				variant="icon"
				size="icon"
				aria-label={
					railCollapsed ? "Open activity rail" : "Close activity rail"
				}
				aria-pressed={railCollapsed}
				onClick={onToggleRail}
			>
				{railCollapsed ? (
					<PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
				) : (
					<PanelRightClose className="h-3.5 w-3.5" aria-hidden />
				)}
			</Button>
		</div>
	);
}
