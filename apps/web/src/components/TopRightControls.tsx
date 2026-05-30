import {
	Moon,
	PanelRightClose,
	PanelRightOpen,
	Settings2,
	Sun,
} from "lucide-react";
import { useState } from "react";
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
	const [theme, setTheme] = useState<"light" | "dark">(() => {
		const initial =
			typeof document !== "undefined"
				? (document.documentElement.dataset.theme as "light" | "dark" | undefined)
				: undefined;
		return initial === "dark" ? "dark" : "light";
	});

	const toggleTheme = () => {
		const next = theme === "dark" ? "light" : "dark";
		setTheme(next);
		document.documentElement.dataset.theme = next;
		try {
			localStorage.setItem("inkstone-theme", next);
		} catch {
			// localStorage may be unavailable — non-fatal
		}
	};

	return (
		<div className="flex items-center gap-1 px-2 py-1 text-sm">
			<Button
				variant="icon"
				size="icon"
				aria-label="Toggle theme"
				onClick={toggleTheme}
			>
				{theme === "dark" ? (
					<Sun className="h-3.5 w-3.5" aria-hidden />
				) : (
					<Moon className="h-3.5 w-3.5" aria-hidden />
				)}
			</Button>
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
				aria-label={railCollapsed ? "Open activity rail" : "Close activity rail"}
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
