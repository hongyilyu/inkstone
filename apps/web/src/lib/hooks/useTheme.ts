import { useState } from "react";
import { THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

export function useTheme() {
	const [theme, setTheme] = useState<Theme>(() => {
		const initial =
			typeof document !== "undefined"
				? (document.documentElement.dataset.theme as Theme | undefined)
				: undefined;
		return initial === "dark" ? "dark" : "light";
	});

	const toggle = () => {
		const next: Theme = theme === "dark" ? "light" : "dark";
		setTheme(next);
		document.documentElement.dataset.theme = next;
		try {
			localStorage.setItem(THEME_STORAGE_KEY, next);
		} catch {
			// localStorage may be unavailable — non-fatal
		}
	};

	return { theme, toggle };
}
