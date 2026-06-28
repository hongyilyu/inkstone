import { X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
	formatDay,
	type LibraryItem,
	libraryItemTitle,
} from "@/lib/libraryItems";
import { focusEntityTimeline } from "@/lib/timeline";
import { EntityGlyph } from "./EntityGlyph.js";

/**
 * The Timeline focused-entity lens (ADR-0054 §4): clicking a Person/Project chip in
 * the feed opens this rail — that one entity's referencing Journal Entries in
 * chronological order. It is the "same entity, different lens" proof: a Person who is
 * a GTD collaborator is, here, an interaction history. Pure presentation over
 * `focusEntityTimeline(items, entityId)` — no new derivation, no new read.
 */

/** The one-line note that names this lens against the entity's GTD role. */
function lensNote(kind: LibraryItem["kind"]): string {
	if (kind === "project") {
		return "In GTD, a workstream. Here, its interaction history.";
	}
	return "In GTD, a collaborator. Here, their interaction history.";
}

export function FocusedEntityRail({
	entityId,
	items,
	onClose,
}: {
	entityId: string;
	items: LibraryItem[];
	onClose: () => void;
}) {
	const entity = items.find((e) => e.id === entityId);
	const title = entity ? libraryItemTitle(entity) : "Referenced entity";
	const days = focusEntityTimeline(items, entityId);

	return (
		<aside
			aria-label={`${title} timeline`}
			className="flex h-full flex-col bg-sidebar"
		>
			<header className="flex items-start gap-3 border-foreground/15 border-b px-5 py-4">
				{entity ? <EntityGlyph entity={entity} size="lg" /> : null}
				<div className="min-w-0 flex-1 pt-0.5">
					<h2 className="truncate font-semibold text-foreground text-lg tracking-tight">
						{title}
					</h2>
					<p className="text-pretty text-muted-foreground text-sm">
						{lensNote(entity?.kind ?? "person")}
					</p>
				</div>
				<Button
					variant="icon"
					size="icon"
					onClick={onClose}
					aria-label="Close timeline lens"
				>
					<X className="size-4" aria-hidden />
				</Button>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				{days.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No Journal Entries mention this yet.
					</p>
				) : (
					<ol className="flex flex-col gap-5">
						{days.map((day) => (
							<li key={day.day}>
								<h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
									{formatDay(day.day)}
								</h3>
								<ul className="mt-1.5 flex flex-col gap-2">
									{day.events.map((event) => (
										<li
											key={event.entry.id}
											className="rounded-lg border border-border/60 px-3 py-2"
										>
											<p className="text-pretty text-foreground text-sm leading-relaxed">
												{event.excerpt}
											</p>
										</li>
									))}
								</ul>
							</li>
						))}
					</ol>
				)}
			</div>
		</aside>
	);
}
