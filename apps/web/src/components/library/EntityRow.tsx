import type { LibraryItem } from "@/lib/libraryItems";
import { libraryItemSubtitle, libraryItemTitle } from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";
import { EntityGlyph } from "./EntityGlyph.js";

/** Generic, selectable row: glyph + title + subtitle. */
export function EntityRow({
	entity,
	selected,
	onSelect,
}: {
	entity: LibraryItem;
	selected?: boolean;
	onSelect: (id: string) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(entity.id)}
			aria-current={selected ? "true" : undefined}
			className={cn(
				"flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
				"focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
				selected ? "bg-secondary/70" : "hover:bg-secondary/40",
			)}
		>
			<EntityGlyph entity={entity} size="sm" />
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium text-foreground text-sm">
					{libraryItemTitle(entity)}
				</span>
				<span className="block truncate text-muted-foreground text-xs">
					{libraryItemSubtitle(entity)}
				</span>
			</span>
		</button>
	);
}
