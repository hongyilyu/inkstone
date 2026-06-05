import { Link } from "@tanstack/react-router";
import { House, MessageSquareText, Moon, Search, Sun } from "lucide-react";
import { KIND_META, KIND_ORDER, kindCounts } from "@/lib/entities";
import { useEntities } from "@/lib/hooks/useEntities";
import { useTheme } from "@/lib/hooks/useTheme";
import { cn } from "@/lib/utils.js";
import { openCommand } from "@/store/command";

const ROW =
	"flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring";
const ROW_ACTIVE = "bg-sidebar-accent font-medium text-sidebar-foreground";

/** Left nav for the Library takeover: return-to-chat, search, the kinds. */
export function LibraryNav() {
	const { theme, toggle } = useTheme();
	const { data } = useEntities();
	const counts = kindCounts(data ?? []);

	return (
		<nav
			aria-label="Library"
			className="flex h-full w-[248px] shrink-0 flex-col bg-sidebar px-3 py-3 text-sidebar-foreground"
		>
			<div className="flex h-9 items-center px-3">
				<span className="font-bold text-base text-foreground tracking-tight">
					Inkstone
				</span>
			</div>

			<div className="mt-3 flex flex-col gap-0.5">
				<Link to="/" className={ROW}>
					<MessageSquareText className="size-4 shrink-0" aria-hidden />
					Chat
				</Link>
				<button
					type="button"
					onClick={openCommand}
					className={cn(ROW, "w-full")}
				>
					<Search className="size-4 shrink-0" aria-hidden />
					<span className="flex-1 text-left">Search</span>
					<kbd className="rounded border border-sidebar-foreground/15 px-1.5 py-0.5 font-medium font-sans text-[10px] text-sidebar-foreground/50">
						⌘K
					</kbd>
				</button>
			</div>

			<div className="mx-3 my-3 border-border border-t" />

			<div className="flex flex-col gap-0.5">
				<Link
					to="/library"
					activeOptions={{ exact: true }}
					className={ROW}
					activeProps={{ className: cn(ROW, ROW_ACTIVE) }}
				>
					<House className="size-4 shrink-0" aria-hidden />
					<span className="flex-1 truncate">Today</span>
				</Link>
				{KIND_ORDER.map((kind) => {
					const meta = KIND_META[kind];
					const Icon = meta.icon;
					return (
						<Link
							key={kind}
							to="/library/$kind"
							params={{ kind: meta.slug }}
							className={ROW}
							activeProps={{ className: cn(ROW, ROW_ACTIVE) }}
						>
							<Icon className="size-4 shrink-0" aria-hidden />
							<span className="flex-1 truncate">{meta.plural}</span>
							<span className="text-sidebar-foreground/45 text-xs tabular-nums">
								{counts[kind]}
							</span>
						</Link>
					);
				})}
			</div>

			<div className="flex-1" />

			<div className="flex items-center justify-between px-1">
				<span
					className="flex size-8 items-center justify-center rounded-full bg-primary font-medium text-primary-foreground text-sm"
					aria-hidden
				>
					H
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
		</nav>
	);
}
