import type { LibraryItem } from "@/lib/libraryItems";
import { KIND_META } from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";

function initials(name: string): string {
	const parts = name.trim().split(/\s+/);
	const first = parts[0]?.[0] ?? "";
	const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
	return (first + second).toUpperCase() || "?";
}

const SIZES = {
	sm: { box: "size-8 text-[11px]", icon: "size-4" },
	md: { box: "size-10 text-sm", icon: "size-5" },
	lg: { box: "size-12 text-base", icon: "size-6" },
} as const;

/** Visual mark for an entity: initials for People, kind glyph otherwise; kinds differ by glyph + label, never colour alone (PRODUCT.md a11y). */
export function EntityGlyph({
	entity,
	size = "md",
	className,
}: {
	entity: LibraryItem;
	size?: keyof typeof SIZES;
	className?: string;
}) {
	const s = SIZES[size];
	const base = cn(
		"flex shrink-0 items-center justify-center bg-secondary text-secondary-foreground",
		s.box,
		className,
	);

	if (entity.kind === "person") {
		return (
			<span className={cn(base, "rounded-full font-semibold")} aria-hidden>
				{initials(entity.name)}
			</span>
		);
	}

	const Icon = KIND_META[entity.kind].icon;
	return (
		<span className={cn(base, "rounded-lg")} aria-hidden>
			<Icon className={s.icon} />
		</span>
	);
}
