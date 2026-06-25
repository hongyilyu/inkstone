import { Button } from "@/components/ui/button.js";
import type { ActiveFacets, FacetGroup, FacetKey } from "@/lib/libraryFacets";
import { hasActiveFacets, isFacetActive } from "@/lib/libraryFacets";
import { cn } from "@/lib/utils.js";

/** One toggle chip for a facet value. Inactive = the `Button variant="chip"`
 * resting state (transparent, hairline border); active = the soft-pink Badge tint
 * (One-Ink: tint, never a new hue). `aria-pressed` carries the on/off state for
 * assistive tech and tests. The trailing count is the leave-one-out match count. */
function FacetChip({
	label,
	count,
	active,
	onToggle,
}: {
	label: string;
	count: number;
	active: boolean;
	onToggle: () => void;
}) {
	return (
		<Button
			variant="chip"
			size="xs"
			aria-pressed={active}
			onClick={onToggle}
			className={cn(
				"rounded-full",
				active &&
					"border-secondary-foreground/25 bg-secondary text-secondary-foreground hover:bg-secondary",
			)}
		>
			<span>{label}</span>
			<span
				className={cn(
					"tabular-nums",
					active ? "text-secondary-foreground/70" : "text-muted-foreground/70",
				)}
			>
				{count}
			</span>
		</Button>
	);
}

/** The inline facet controls beneath the search field: one labelled group per
 * derived facet, each a row of toggle chips. A chip whose leave-one-out count is 0
 * is hidden (it would only narrow to nothing). A single "Clear" resets the facets
 * (not the text query) when any facet is active. The whole row renders nothing when
 * `groups` is empty (a kind with no partitionable facets). */
export function FacetRow({
	groups,
	active,
	counts,
	onToggle,
	onClear,
}: {
	groups: FacetGroup[];
	active: ActiveFacets;
	/** Per-group leave-one-out counts: group key → (value → count). Partial — only
	 * the rendered groups carry an entry; absent keys fall back to an empty Map. */
	counts: Partial<Record<FacetKey, Map<string, number>>>;
	onToggle: (key: FacetKey, value: string) => void;
	onClear: () => void;
}) {
	if (groups.length === 0) return null;
	const anyActive = hasActiveFacets(active);

	return (
		// biome-ignore lint/a11y/useSemanticElements: role="group" + aria-label is the correct WAI-ARIA pattern for a labelled set of filter controls; <fieldset> would import form-reset/border semantics this toolbar doesn't want
		<div role="group" aria-label="Filters" className="mt-3 flex flex-col gap-2">
			{groups.map((group) => {
				const groupCounts = counts[group.key] ?? new Map<string, number>();
				const visible = group.values.filter(
					(v) =>
						isFacetActive(active, group.key, v.value) ||
						(groupCounts.get(v.value) ?? 0) > 0,
				);
				if (visible.length === 0) return null;
				return (
					<div key={group.key} className="flex flex-wrap items-center gap-1.5">
						<span className="mr-1 w-12 shrink-0 text-muted-foreground text-xs">
							{group.label}
						</span>
						{visible.map((value) => (
							<FacetChip
								key={value.value}
								label={value.label}
								count={groupCounts.get(value.value) ?? 0}
								active={isFacetActive(active, group.key, value.value)}
								onToggle={() => onToggle(group.key, value.value)}
							/>
						))}
					</div>
				);
			})}
			{anyActive ? (
				<button
					type="button"
					onClick={onClear}
					className="self-start rounded text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
				>
					Clear
				</button>
			) : null}
		</div>
	);
}
