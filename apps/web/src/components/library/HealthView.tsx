import { HeartPulse } from "lucide-react";
import { useState } from "react";
import { ObservationField } from "@/components/ProposalCardObservations";
import { EmptyState } from "@/components/ui/empty-state";
import { useObservations } from "@/lib/hooks/useObservations";
import { useObservationUpdate } from "@/lib/hooks/useObservationUpdate";
import { formatDay } from "@/lib/libraryItems";
import {
	groupObservationsByDay,
	type ObservationItemView,
} from "@/lib/observationView";
import { cn } from "@/lib/utils.js";
import { ObservationCorrectionForm } from "./ObservationCorrectionForm.js";

/** The active schema filter; `undefined` = All. Only the schemas we render a chip
 * for are selectable — the route validates `?schema=` against these. */
export type HealthFilter = "bodyweight" | "habit.checkin" | undefined;

/** Display labels for the schemas we offer a dedicated chip for, in chip order. A
 * schema absent from this map stays reachable under All but never gets a chip. */
const SCHEMA_LABELS: Record<NonNullable<HealthFilter>, string> = {
	bodyweight: "Bodyweight",
	"habit.checkin": "Habits",
};

/** The schemas that get a dedicated filter chip. Exported so the route validates
 * `?schema=` against exactly the chip set this view renders (one source of truth). */
export const KNOWN_SCHEMAS = Object.keys(
	SCHEMA_LABELS,
) as NonNullable<HealthFilter>[];

/** A display-only "Captured from" line — text only, no link, no navigation. Shown
 * only when the observation carries a recorded source. Keyed purely on `relation`
 * (Core pairs `evidenced_by` with a Message and `created_from` with a Journal
 * Entry), so the label can't contradict the relation. */
function capturedFromText(
	source: ObservationItemView["source"],
): string | null {
	if (source == null) return null;
	return source.relation === "evidenced_by"
		? "Captured from a message"
		: "Captured from a Journal Entry";
}

/**
 * The Health topic surface (ADR-0054 §4): a calm day-grouped chronological stream
 * of recorded observations (ADR-0053). Read-only — no record/edit/delete, no
 * charts or aggregates. Schema filter chips let you narrow to one stream; the
 * active filter is owned by the route via `?schema=` (this component is
 * controlled). Mirrors `TimelineView`'s idiom, minus the focus rail (observations
 * are not entities).
 */
export function HealthView({
	filter,
	onFilterChange,
}: {
	filter: HealthFilter;
	onFilterChange: (filter: HealthFilter) => void;
}) {
	const { data, isPending, isError } = useObservations();
	const items = data ?? [];

	// The single active inline correction editor, tracked by observation id (null =
	// none open). One JSON-values + scalar-fields form drives `observation/update`;
	// success refetches the stream and clears the editor.
	const [editingId, setEditingId] = useState<string | null>(null);
	const correction = useObservationUpdate();
	const correctionError =
		correction.error == null
			? null
			: correction.error instanceof Error && correction.error.message
				? correction.error.message
				: "Couldn't save the correction. Try again.";

	// One mutation instance backs every row's editor, so its error/pending state is
	// shared. Reset it whenever the active editor changes (open, switch, or cancel)
	// so a prior row's failed-save error never bleeds into a freshly opened form.
	const openEditor = (id: string | null) => {
		correction.reset();
		setEditingId(id);
	};

	// Chip set = All + one chip per KNOWN schema actually present in the data, so
	// unknown-schema rows stay reachable under All without manufacturing a chip.
	// The active `filter` is always kept (it's route-controlled — e.g. a bookmarked
	// `?schema=bodyweight` is valid even with zero bodyweight rows), so the user can
	// always see and clear the filter they're on.
	const present = new Set(items.map((i) => i.schemaKey));
	const schemaChips = KNOWN_SCHEMAS.filter(
		(key) => present.has(key) || key === filter,
	);

	const visible =
		filter === undefined ? items : items.filter((i) => i.schemaKey === filter);
	const days = groupObservationsByDay(visible);

	return (
		<section
			aria-label="Health"
			className="flex h-full min-h-0 flex-1 flex-col"
		>
			{/* A visual row of filter toggle buttons (each self-labeled); not an ARIA
			    tablist — that contract needs roving focus + aria-controls we don't have. */}
			<div className="flex shrink-0 flex-wrap gap-1 px-6 pt-4 pb-3">
				{[null, ...schemaChips].map((key) => {
					const active = (key ?? undefined) === filter;
					const label = key === null ? "All" : SCHEMA_LABELS[key];
					const count =
						key === null
							? items.length
							: items.filter((i) => i.schemaKey === key).length;
					return (
						<button
							key={key ?? "all"}
							type="button"
							aria-pressed={active}
							onClick={() => onFilterChange(key ?? undefined)}
							className={cn(
								"inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium text-sm transition-colors",
								"focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
								active
									? "bg-secondary text-foreground"
									: "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
							)}
						>
							{label}
							{count > 0 ? (
								<span className="tabular-nums text-muted-foreground text-xs">
									{count}
								</span>
							) : null}
						</button>
					);
				})}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
				<div className="mx-auto w-full max-w-3xl">
					{isPending ? null : isError ? (
						<EmptyState
							icon={HeartPulse}
							tone="danger"
							title="Couldn't load health"
							description="Something went wrong reading your observations. Try reloading."
						/>
					) : days.length === 0 ? (
						filter !== undefined && items.length > 0 ? (
							// Some observations exist, just none under the active filter — say
							// so, rather than the misleading "workspace is empty" copy.
							<EmptyState
								icon={HeartPulse}
								title={`No ${SCHEMA_LABELS[filter].toLowerCase()} observations yet`}
								description="Try a different filter, or clear it to see your other observations."
							/>
						) : (
							<EmptyState
								icon={HeartPulse}
								title="No observations yet"
								description="Bodyweight, habits, and other observations show up here in time order as they're recorded."
							/>
						)
					) : (
						<ol className="flex flex-col gap-6">
							{days.map((day) => (
								<li key={day.day}>
									<h2 className="sticky top-0 bg-background py-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
										{formatDay(day.day)}
									</h2>
									<ul className="mt-1 flex flex-col gap-3">
										{day.items.map((item) => {
											const captured = capturedFromText(item.source);
											return (
												<li
													key={item.id}
													className="rounded-lg border border-border/60 px-4 py-3"
												>
													<p className="text-foreground text-sm leading-relaxed">
														{item.summary}
													</p>
													{item.fields.length > 0 ? (
														<dl className="mt-2 flex flex-col gap-1.5 text-sm">
															{item.fields.map((field) => (
																<ObservationField
																	key={field.label}
																	label={field.label}
																	value={field.value}
																/>
															))}
														</dl>
													) : null}
													{item.note ? (
														<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
															{item.note}
														</p>
													) : null}
													{captured ? (
														<p className="mt-2 text-muted-foreground text-xs">
															{captured}
														</p>
													) : null}
													{editingId === item.id ? (
														<ObservationCorrectionForm
															item={item}
															submitting={correction.isPending}
															error={correctionError}
															onCancel={() => openEditor(null)}
															onSubmit={(params) =>
																correction.mutate(params, {
																	// Close only if THIS row is still the active editor —
																	// guards against a slow save resolving after the user
																	// has already opened a different row (which would
																	// otherwise close that row and lose its draft).
																	onSuccess: () =>
																		setEditingId((current) =>
																			current === item.id ? null : current,
																		),
																})
															}
														/>
													) : (
														<button
															type="button"
															onClick={() => openEditor(item.id)}
															className="mt-2 text-muted-foreground text-xs hover:text-foreground"
														>
															Correct
														</button>
													)}
												</li>
											);
										})}
									</ul>
								</li>
							))}
						</ol>
					)}
				</div>
			</div>
		</section>
	);
}
