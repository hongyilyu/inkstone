import { Moon, Sun } from "lucide-react";
import { useState } from "react";

export function TopRightControls() {
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
		<div className="flex items-center gap-2 px-2 py-1 text-sm">
			<button
				type="button"
				aria-label="Toggle theme"
				onClick={toggleTheme}
				className="rounded-md p-1.5 text-foreground/60 hover:bg-accent hover:text-accent-foreground"
			>
				{theme === "dark" ? (
					<Sun
						className="h-3.5 w-3.5"
						aria-hidden
					/>
				) : (
					<Moon
						className="h-3.5 w-3.5"
						aria-hidden
					/>
				)}
			</button>
		</div>
	);
}
