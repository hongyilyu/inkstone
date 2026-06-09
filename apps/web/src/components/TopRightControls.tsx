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
		<div className="flex items-center rounded-lg bg-secondary/55 p-0.5">
			<Button
				variant="icon"
				size="icon"
				className="text-foreground hover:bg-foreground/10 hover:text-foreground"
				aria-label="Settings"
				onClick={onOpenSettings}
			>
				<Settings2 className="h-3.5 w-3.5" aria-hidden />
			</Button>
			<span aria-hidden className="mx-px my-[3px] w-px self-stretch bg-border" />
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
