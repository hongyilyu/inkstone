import type { Entity } from "@/lib/entities";
import { KIND_META } from "@/lib/entities";
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

/**
 * The visual mark for an entity: initials for People, the kind glyph for
 * everything else. Uniform secondary tint across kinds — kinds are
 * distinguished by glyph + adjacent label, never by colour alone (PRODUCT.md
 * a11y). Always `aria-hidden`; the entity's name sits beside it as text.
 */
export function EntityGlyph({
	entity,
	size = "md",
	className,
}: {
	entity: Entity;
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
