import { useState } from "react";
import { THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

export function useTheme() {
	const [theme, setTheme] = useState<Theme>(() => {
		// A non-DOM environment (SSR, a bare test) has no `document`; otherwise the
		// dataset carries whatever the boot script already applied.
		const applied =
			"document" in globalThis
				? document.documentElement.dataset.theme
				: undefined;
		return applied === "dark" ? "dark" : "light";
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
