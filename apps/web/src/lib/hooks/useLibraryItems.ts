import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { entities } from "@/data/mock/entities";
import type {
	JournalEntry,
	JournalEntryBodyNode,
	LibraryItem,
	Person,
	Project,
	ProjectStatus,
	Todo,
	TodoStatus,
} from "@/lib/libraryItems";
import { useRuntime } from "@/runtime";

const previewItems: LibraryItem[] = entities.filter(
	(e) => e.kind !== "journal_entry",
);

interface LiveEntityRow {
	readonly id: string;
	readonly data: unknown;
	readonly created_at: number;
	readonly refs?: readonly LiveResolvedEntityRef[];
	readonly person_refs?: readonly LiveTodoPersonRef[];
}

interface LiveTodoPersonRef {
	readonly person_id: string;
	readonly role: "waiting_on" | "related";
}

interface LiveResolvedEntityRef {
	readonly id: string;
	readonly source_entity_id: string;
	readonly target_entity_id: string;
	readonly target_entity_type: "person" | "project" | "todo";
	readonly target_title?: string;
	readonly label_snapshot?: string;
}

/** The Library's displayed items — live Journal/People/Projects/Todo rows from Core, preview rows for the rest; live rows replace preview rows per kind. */
export function useLibraryItems() {
	const runtime = useRuntime();
	return useQuery({
		queryKey: ["library-items"],
		placeholderData: previewItems,
		queryFn: async () => {
			const program = Effect.gen(function* () {
				const client = yield* WsClient;
				// Effect.all is sequential by default — set concurrency to fetch these reads concurrently.
				const [journalEntries, todos, people] = yield* Effect.all(
					[
						client.listEntities("journal_entry"),
						client.listEntities("todo"),
						client.listEntities("person"),
					],
					{ concurrency: 2 },
				);
				return {
					journalEntries: journalEntries.entities,
					todos: todos.entities,
					people: people.entities,
				};
			});
			let rows: {
				journalEntries: readonly LiveEntityRow[];
				todos: readonly LiveEntityRow[];
				people: readonly LiveEntityRow[];
			};
			try {
				rows = await runtime.runPromise(program);
			} catch {
				// Web preview runs without Core — keep preview items; strict live row validation stays below this read boundary.
				return previewItems;
			}
			let projects: readonly LiveEntityRow[] = [];
			try {
				const projectRows = await runtime.runPromise(
					Effect.gen(function* () {
						const client = yield* WsClient;
						return yield* client.listEntities("project");
					}),
				);
				projects = projectRows.entities;
			} catch {
				// Projects are additive during this migration; keep the other live lists if only this read fails.
			}
			const { journalEntries, todos, people } = rows;
			const liveJournalEntries = journalEntries.map(toLibraryJournalEntry);
			const liveTodos = todos.map(toLibraryTodo);
			const livePeople = people.map(toLibraryPerson);
			const liveProjects = projects.map(toLibraryProject);
			const hasLiveTodos = liveTodos.length > 0;
			const hasLivePeople = livePeople.length > 0;
			const hasLiveProjects = liveProjects.length > 0;
			const remainingPreviewItems = previewItems.filter(
				(e) =>
					(e.kind !== "todo" || !hasLiveTodos) &&
					(e.kind !== "person" || !hasLivePeople) &&
					(e.kind !== "project" || !hasLiveProjects),
			);
			return [
				...liveJournalEntries,
				...liveTodos,
				...livePeople,
				...liveProjects,
				...remainingPreviewItems,
			];
		},
	});
}

interface JournalEntryData {
	occurred_at?: unknown;
	body?: unknown;
}

const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function toLibraryJournalEntry(row: LiveEntityRow): JournalEntry {
	const data = (row.data ?? {}) as JournalEntryData;
	if (
		typeof data.occurred_at !== "string" ||
		!LOCAL_DATETIME_RE.test(data.occurred_at)
	) {
		throw new Error(
			`Invalid journal_entry ${row.id}: occurred_at must use YYYY-MM-DDTHH:MM:SS`,
		);
	}
	if (!Array.isArray(data.body) || data.body.length === 0) {
		throw new Error(`Invalid journal_entry ${row.id}: body must not be empty`);
	}
	const refsById = new Map((row.refs ?? []).map((ref) => [ref.id, ref]));
	const body: JournalEntryBodyNode[] = data.body.map((node) => {
		if (!node || typeof node !== "object") {
			throw new Error(
				`Invalid journal_entry ${row.id}: body nodes must be objects`,
			);
		}
		const record = node as Record<string, unknown>;
		if (record.type === "entity_ref") {
			if (typeof record.ref_id !== "string" || record.ref_id.trim() === "") {
				throw new Error(
					`Invalid journal_entry ${row.id}: entity_ref ref_id must not be empty`,
				);
			}
			const ref = refsById.get(record.ref_id);
			return {
				type: "entity_ref",
				refId: record.ref_id,
				targetEntityId: ref?.target_entity_id,
				targetKind: ref?.target_entity_type,
				targetTitle: ref?.target_title,
				labelSnapshot: ref?.label_snapshot,
			};
		}
		if (record.type !== "text") {
			throw new Error(
				`Invalid journal_entry ${row.id}: body supports only text or entity_ref nodes`,
			);
		}
		if (typeof record.text !== "string" || record.text.trim() === "") {
			throw new Error(
				`Invalid journal_entry ${row.id}: body text must not be empty`,
			);
		}
		return { type: "text", text: record.text };
	});
	return {
		id: row.id,
		kind: "journal_entry",
		occurredAt: data.occurred_at,
		body,
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies JournalEntry;
}

/** The Todo `data` shape Core stores (ADR-0031): GTD `status` + date fields. */
interface TodoData {
	title?: unknown;
	note?: unknown;
	status?: unknown;
	project_id?: unknown;
	defer_at?: unknown;
	due_at?: unknown;
	completed_at?: unknown;
	dropped_at?: unknown;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asTodoStatus(value: unknown): TodoStatus {
	return value === "completed" || value === "dropped" ? value : "active";
}

/** Map a live `entity/list` row to the Library `Todo` view model (ADR-0031). */
function toLibraryTodo(row: LiveEntityRow): Todo {
	const data = (row.data ?? {}) as TodoData;
	return {
		id: row.id,
		kind: "todo",
		title: asString(data.title) ?? "Untitled",
		note: asString(data.note),
		status: asTodoStatus(data.status),
		projectId: asString(data.project_id),
		deferAt: asString(data.defer_at),
		dueAt: asString(data.due_at),
		completedAt: asString(data.completed_at),
		droppedAt: asString(data.dropped_at),
		personRefs: (row.person_refs ?? []).map((ref) => ({
			personId: ref.person_id,
			role: ref.role,
		})),
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies Todo;
}

/** The Person `data` shape Core stores (ADR-0031): `{name, note?, aliases?}`. */
interface PersonData {
	name?: unknown;
	note?: unknown;
	aliases?: unknown;
}

/** Map a live `entity/list` row to the Library `Person` view model (ADR-0031). */
function toLibraryPerson(row: LiveEntityRow): Person {
	const data = (row.data ?? {}) as PersonData;
	const aliases = Array.isArray(data.aliases)
		? data.aliases.filter((a): a is string => typeof a === "string")
		: undefined;
	return {
		id: row.id,
		kind: "person",
		name: asString(data.name) ?? "Unnamed",
		note: asString(data.note),
		aliases: aliases && aliases.length > 0 ? aliases : undefined,
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies Person;
}

/** The Project `data` shape Core stores (ADR-0031): GTD `status` + review metadata. */
interface ProjectData {
	name?: unknown;
	status?: unknown;
	outcome?: unknown;
	note?: unknown;
	next_review_at?: unknown;
	last_reviewed_at?: unknown;
}

function asProjectStatus(value: unknown): ProjectStatus {
	return value === "on_hold" || value === "completed" || value === "dropped"
		? value
		: "active";
}

function toLibraryProject(row: LiveEntityRow): Project {
	const data = (row.data ?? {}) as ProjectData;
	// Carry the complete stored object verbatim so the editor can build a
	// full-document-replace `update_project` without dropping server-managed
	// fields the projection above omits (slice-7).
	const rawData =
		row.data && typeof row.data === "object"
			? { ...(row.data as Record<string, unknown>) }
			: {};
	return {
		id: row.id,
		kind: "project",
		name: asString(data.name) ?? "Untitled",
		status: asProjectStatus(data.status),
		outcome: asString(data.outcome),
		note: asString(data.note),
		nextReviewAt: asString(data.next_review_at),
		lastReviewedAt: asString(data.last_reviewed_at),
		data: rawData,
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies Project;
}
