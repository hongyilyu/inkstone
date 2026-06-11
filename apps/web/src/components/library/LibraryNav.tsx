import { Link, useNavigate } from "@tanstack/react-router";
import { House, MessageSquareText, Search } from "lucide-react";
import { NavShell, navRow, navRowActive } from "@/components/ui/nav-shell";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	KIND_META,
	KIND_ORDER,
	libraryItemKindCounts,
} from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";
import { openCommand } from "@/store/command";

/** Left nav for the Library takeover: return-to-chat, search, the kinds. */
export function LibraryNav() {
	const navigate = useNavigate();
	const { data } = useLibraryItems();
	const counts = libraryItemKindCounts(data ?? []);

	return (
		<NavShell
			as="nav"
			ariaLabel="Library"
			onOpenSettings={() => navigate({ to: "/settings/models" })}
		>
			<div className="flex flex-col gap-0.5">
				<Link to="/" className={navRow}>
					<MessageSquareText className="size-4 shrink-0" aria-hidden />
					Chat
				</Link>
				<button
					type="button"
					onClick={openCommand}
					className={cn(navRow, "w-full")}
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
					className={navRow}
					activeProps={{ className: cn(navRow, navRowActive) }}
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
							className={navRow}
							activeProps={{ className: cn(navRow, navRowActive) }}
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
		</NavShell>
	);
}
