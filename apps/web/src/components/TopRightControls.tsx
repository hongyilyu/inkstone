import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { Button } from "./ui/button.js";

export interface TopRightControlsProps {
	onToggleRail?: () => void;
	railCollapsed?: boolean;
}

export function TopRightControls({
	onToggleRail,
	railCollapsed = false,
}: TopRightControlsProps = {}) {
	return (
		<div className="flex items-center rounded-lg bg-secondary/55 p-0.5">
			<Button
				variant="icon"
				size="icon"
				className="text-foreground hover:bg-foreground/10 hover:text-foreground"
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
