import { loadConfig, saveConfig } from "@backend/persistence/config";
import type { SyntaxStyle } from "@opentui/core";
import {
	type Accessor,
	batch,
	createContext,
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	type ParentProps,
	useContext,
} from "solid-js";
import { createStore } from "solid-js/store";
import { getThemeById, themes } from "../theme/palettes";
import { generateSubtleSyntax, generateSyntax } from "../theme/syntax";
import type { ThemeColors, ThemeDef } from "../theme/types";

// Re-exports keep the old `import { ... } from "../context/theme"` call
// sites working after the data/syntax split. `context/theme` remains
// the single import site consumers know about; the split is an
// internal reorganization.
export type { ThemeColors, ThemeDef };
export { getThemeById, themes };

interface ThemeContext {
	theme: ThemeColors;
	themeId: () => string;
	setTheme: (id: string) => void;
	syntax: Accessor<SyntaxStyle>;
	subtleSyntax: Accessor<SyntaxStyle>;
}

const ctx = createContext<ThemeContext>();

export function ThemeProvider(props: ParentProps) {
	const savedId = loadConfig().themeId ?? "dark";
	const [themeId, setThemeId] = createSignal(savedId);
	const [theme, setThemeColors] = createStore<ThemeColors>({
		...getThemeById(savedId).colors,
	});

	// Update store reactively when themeId signal changes
	createEffect(
		on(
			themeId,
			(id) => {
				const colors = getThemeById(id).colors;
				batch(() => {
					for (const [key, value] of Object.entries(colors)) {
						// Store fields are heterogeneous (RGBA for colors + one
						// `thinkingOpacity: number`). Solid's `setStore` has an
						// overload that accepts `unknown` per-key; cast to that
						// instead of lying to TS with `as RGBA`.
						setThemeColors(key as keyof ThemeColors, value as never);
					}
				});
			},
			{ defer: true },
		),
	);

	// Regenerate SyntaxStyle whenever the active theme changes.
	// The memo depends on themeId — the store itself isn't tracked here
	// because each field is a separate reactive source; keying off themeId
	// avoids re-creating the style on every color write inside batch().
	//
	// SyntaxStyle wraps an FFI Pointer (see @opentui/core/zig.d.ts: destroySyntaxStyle).
	// JS GC cannot free the Zig-side allocations, so we explicitly .destroy() the
	// previous instance via onCleanup — fires on recompute (theme switch) and on
	// provider disposal (app exit).
	const syntax = createMemo(() => {
		const id = themeId();
		const style = generateSyntax(getThemeById(id).colors);
		onCleanup(() => style.destroy());
		return style;
	});

	// Sibling of `syntax` for reasoning ("thinking") blocks. Same FFI cleanup
	// contract; alpha-faded per-scope via `colors.thinkingOpacity`.
	const subtleSyntax = createMemo(() => {
		const id = themeId();
		const style = generateSubtleSyntax(getThemeById(id).colors);
		onCleanup(() => style.destroy());
		return style;
	});

	const value: ThemeContext = {
		theme,
		themeId,
		setTheme(id: string) {
			setThemeId(id);
			saveConfig({ themeId: id });
		},
		syntax,
		subtleSyntax,
	};
	return <ctx.Provider value={value}>{props.children}</ctx.Provider>;
}

export function useTheme() {
	const value = useContext(ctx);
	if (!value) throw new Error("useTheme must be used within a ThemeProvider");
	return value;
}
