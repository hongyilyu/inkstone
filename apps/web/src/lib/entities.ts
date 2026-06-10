import {
	BookOpenText,
	ChefHat,
	FolderKanban,
	ListTodo,
	type LucideIcon,
	User,
} from "lucide-react";
import {
	type Entity,
	type EntityKind,
	entities,
	type Person,
	type Project,
	type Todo,
} from "@/data/mock/entities";

export type {
	Entity,
	EntityKind,
	JournalEntry,
	Person,
	Project,
	Recipe,
	Todo,
} from "@/data/mock/entities";

interface KindMeta {
	/** Singular noun, e.g. "Person". */
	label: string;
	/** Plural noun, e.g. "People". */
	plural: string;
	/** URL slug used by `/library/$kind`. */
	slug: string;
	icon: LucideIcon;
}

/** Display order is deliberate: journal captures first, then structured Entities. */
export const KIND_ORDER: EntityKind[] = [
	"journal_entry",
	"person",
	"project",
	"todo",
	"recipe",
];

export const KIND_META: Record<EntityKind, KindMeta> = {
	journal_entry: {
		label: "Journal Entry",
		plural: "Journal",
		slug: "journal",
		icon: BookOpenText,
	},
	person: { label: "Person", plural: "People", slug: "people", icon: User },
	project: {
		label: "Project",
		plural: "Projects",
		slug: "projects",
		icon: FolderKanban,
	},
	todo: { label: "Todo", plural: "Todos", slug: "todos", icon: ListTodo },
	recipe: {
		label: "Recipe",
		plural: "Recipes",
		slug: "recipes",
		icon: ChefHat,
	},
};

const SLUG_TO_KIND: Record<string, EntityKind> = {
	journal: "journal_entry",
	people: "person",
	projects: "project",
	todos: "todo",
	recipes: "recipe",
};

export function kindForSlug(slug: string): EntityKind | undefined {
	return SLUG_TO_KIND[slug];
}

/** The user-facing title of any entity (people use `name`, the rest `title`). */
export function entityTitle(e: Entity): string {
	if (e.kind === "journal_entry") return e.body;
	return e.kind === "person" || e.kind === "project" ? e.name : e.title;
}

/** A one-line subtitle for list rows and search results. */
export function entitySubtitle(e: Entity): string {
	switch (e.kind) {
		case "journal_entry":
			return e.occurredAt;
		case "person":
			return e.role ?? e.relationship ?? "Person";
		case "project":
			return e.summary ?? PROJECT_STATUS_LABEL[e.status];
		case "todo":
			return e.due ? `Due ${e.due}` : (e.note ?? "No due date");
		case "recipe":
			return (
				[e.time, e.tags?.join(", ")].filter(Boolean).join(" · ") || "Recipe"
			);
	}
}

export const PROJECT_STATUS_LABEL: Record<Project["status"], string> = {
	active: "Active",
	review: "In review",
	paused: "Paused",
	done: "Done",
};

// --- lookups ----------------------------------------------------------------

export function getEntity(id: string | null | undefined): Entity | undefined {
	if (!id) return undefined;
	return entities.find((e) => e.id === id);
}

export function entitiesOfKind(kind: EntityKind): Entity[] {
	return entities.filter((e) => e.kind === kind);
}

export function kindCounts(all: Entity[]): Record<EntityKind, number> {
	const counts: Record<EntityKind, number> = {
		journal_entry: 0,
		person: 0,
		project: 0,
		todo: 0,
		recipe: 0,
	};
	for (const e of all) counts[e.kind] += 1;
	return counts;
}

export function todosForProject(all: Entity[], project: Project): Todo[] {
	const ids = new Set(project.todoIds ?? []);
	return all.filter((e): e is Todo => e.kind === "todo" && ids.has(e.id));
}

export function peopleForProject(all: Entity[], project: Project): Person[] {
	const ids = new Set(project.personIds ?? []);
	return all.filter((e): e is Person => e.kind === "person" && ids.has(e.id));
}

export function projectsForPerson(all: Entity[], person: Person): Project[] {
	const ids = new Set(person.projectIds ?? []);
	return all.filter((e): e is Project => e.kind === "project" && ids.has(e.id));
}

export function projectForTodo(all: Entity[], todo: Todo): Project | undefined {
	if (!todo.projectId) return undefined;
	return all.find(
		(e): e is Project => e.kind === "project" && e.id === todo.projectId,
	);
}

// --- derived views ----------------------------------------------------------

/** Most recently captured entities, newest first. */
export function recentlyCaptured(all: Entity[], limit = 6): Entity[] {
	return [...all].sort((a, b) => b.recency - a.recency).slice(0, limit);
}

/** Accepted but unconfirmed — the "Needs review" digest, newest first. */
export function needsReview(all: Entity[]): Entity[] {
	return all.filter((e) => e.needsReview).sort((a, b) => b.recency - a.recency);
}

/** Open todos due within `withinDays`, overdue first, then by soonest. */
export function dueSoon(all: Entity[], withinDays = 3): Todo[] {
	return all
		.filter(
			(e): e is Todo =>
				e.kind === "todo" &&
				!e.done &&
				e.dueInDays !== undefined &&
				e.dueInDays <= withinDays,
		)
		.sort((a, b) => (a.dueInDays ?? 0) - (b.dueInDays ?? 0));
}

export function activeProjects(all: Entity[]): Project[] {
	return all
		.filter((e): e is Project => e.kind === "project" && e.status !== "done")
		.sort((a, b) => b.recency - a.recency);
}

export function projectProgress(
	all: Entity[],
	project: Project,
): { done: number; total: number } {
	const ts = todosForProject(all, project);
	return { done: ts.filter((t) => t.done).length, total: ts.length };
}

// --- search -----------------------------------------------------------------

export interface EntityMatch {
	entity: Entity;
	score: number;
}

/**
 * Rank entities against a query. Title prefix beats word-boundary beats
 * substring; subtitle hits score lower. Empty query returns recents.
 */
export function searchEntities(all: Entity[], query: string): Entity[] {
	const q = query.trim().toLowerCase();
	if (!q) return recentlyCaptured(all, 8);

	const matches: EntityMatch[] = [];
	for (const entity of all) {
		const title = entityTitle(entity).toLowerCase();
		const subtitle = entitySubtitle(entity).toLowerCase();
		let score = 0;
		if (title.startsWith(q)) score = 100;
		else if (new RegExp(`\\b${escapeRegExp(q)}`).test(title)) score = 80;
		else if (title.includes(q)) score = 60;
		else if (subtitle.includes(q)) score = 30;
		if (score > 0) matches.push({ entity, score });
	}
	return matches
		.sort((a, b) => b.score - a.score || b.entity.recency - a.entity.recency)
		.map((m) => m.entity);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
