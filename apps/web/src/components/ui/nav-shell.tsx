import { Moon, Sun } from "lucide-react";
import type { ElementType, ReactNode } from "react";
import { useTheme } from "@/lib/hooks/useTheme";

/**
 * Shared row idiom for nav links/buttons across the chat Sidebar and the
 * Library nav: a 9-rem-tall rounded row that washes to `sidebar-accent` on
 * hover. `navRowActive` marks the current route.
 */
export const navRow =
	"flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring";
export const navRowActive =
	"bg-sidebar-accent font-medium text-sidebar-foreground";

/**
 * The shared left-nav shell both the chat Sidebar and the Library nav render
 * into, so the two surfaces wear identical chrome: the "Inkstone" wordmark with
 * the theme toggle alongside it, a body slot, and a pinned account glyph. Only
 * the landmark element differs — chat passes `as="aside"` to keep the
 * `complementary` role its tests and the e2e page object assert; Library keeps
 * the `navigation` role via the default `nav`.
 */
export function NavShell({
	as: Tag = "nav",
	ariaLabel,
	children,
}: {
	as?: ElementType;
	ariaLabel: string;
	children: ReactNode;
}) {
	const { theme, toggle } = useTheme();
	return (
		<Tag
			aria-label={ariaLabel}
			className="flex h-full w-64 shrink-0 flex-col bg-sidebar px-3 py-3 text-sm text-sidebar-foreground"
		>
			<div className="flex h-9 items-center justify-between gap-2 pr-1 pl-3">
				<span className="font-bold text-base text-foreground tracking-tight">
					Inkstone
				</span>
				<button
					type="button"
					onClick={toggle}
					aria-label="Toggle theme"
					className="flex size-8 items-center justify-center rounded-lg text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
				>
					{theme === "dark" ? (
						<Sun className="size-4" aria-hidden />
					) : (
						<Moon className="size-4" aria-hidden />
					)}
				</button>
			</div>

			<div className="mt-3 flex min-h-0 flex-1 flex-col">{children}</div>

			<div className="flex items-center px-1 pt-2">
				<span
					className="flex size-8 items-center justify-center rounded-full bg-primary font-medium text-primary-foreground text-sm"
					aria-hidden
				>
					H
				</span>
			</div>
		</Tag>
	);
}
