import { Moon, Settings2, Sun } from "lucide-react";
import type { ElementType, ReactNode } from "react";
import { useTheme } from "@/lib/hooks/useTheme";

/** Shared nav row idiom (chat Sidebar + Library nav): rounded row that washes to `sidebar-accent` on hover; `navRowActive` marks the current route. */
export const navRow =
	"flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring";
export const navRowActive =
	"bg-sidebar-accent font-medium text-sidebar-foreground";

/** Shared left-nav shell (chat Sidebar + Library nav): wordmark, theme toggle, body slot, pinned account glyph; `as` sets the landmark (chat `aside`, Library default `nav`). */
export function NavShell({
	as: Tag = "nav",
	ariaLabel,
	onOpenSettings,
	children,
}: {
	as?: ElementType;
	ariaLabel: string;
	onOpenSettings?: () => void;
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

			{/* `pb-5` lifts this row 32px off the grid bottom to align the account glyph with the chat composer's control row. */}
			<div className="flex items-center justify-between px-1 pt-2 pb-5">
				<span
					className="flex size-8 items-center justify-center rounded-full bg-primary font-medium text-primary-foreground text-sm"
					aria-hidden
				>
					H
				</span>
				{onOpenSettings && (
					<button
						type="button"
						onClick={onOpenSettings}
						aria-label="Settings"
						className="flex size-8 items-center justify-center rounded-lg text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
					>
						<Settings2 className="size-5" aria-hidden />
					</button>
				)}
			</div>
		</Tag>
	);
}
