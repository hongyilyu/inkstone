import type { ProposalReviewContext } from "@inkstone/protocol";
import type { ReactNode } from "react";
import { asRecurrence } from "@/lib/entityCodec";
import {
	PROJECT_STATUS_LABEL,
	recurrenceSummary,
	TODO_STATUS_LABEL,
} from "@/lib/libraryItems";
import { arrayField, objectField, textField } from "./proposalPayload.js";

/**
 * Inputs a row's `renderBody` strategy reads to draw the card's detail body — the
 * opaque wire `payload` and the optional review context (the latter carries the
 * current Journal Entry for update/delete diffs). Both are read through the
 * defensive helpers, never a typed decode (ADR-0009/0014).
 */
export interface ProposalBodyArgs {
	payload: unknown;
	reviewContext: ProposalReviewContext | undefined;
	/** Resolve an entity id to its display name via the warm library cache (the
	 * same cache the decided-card link reads). Returns null when the id isn't in
	 * cache yet, so the caller can fall back to a short id rather than a raw UUID. */
	nameFor: (id: string) => string | null;
}

/**
 * Flatten a Journal Entry body's `text`/`entity_ref` nodes to a plain string for
 * the card's summary/detail lines. An `entity_ref` node renders as the literal
 * `[entity_ref]` marker (the woven chip has no inline text here). Reads the opaque
 * payload defensively (ADR-0009/0014); an empty/malformed body degrades to "".
 */
export function journalBody(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const body = (payload as Record<string, unknown>).body;
	if (!Array.isArray(body)) return "";
	return body
		.map((node) => {
			if (!node || typeof node !== "object") return "";
			const record = node as Record<string, unknown>;
			if (record.type === "entity_ref") return "[entity_ref]";
			return record.type === "text" && typeof record.text === "string"
				? record.text
				: "";
		})
		.join("");
}

/** Whether a Journal Entry body carries any `entity_ref` node (gates the inline
 * Edit affordance — a woven body is not re-editable as plain prose). */
export function journalBodyHasEntityRef(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const body = (payload as Record<string, unknown>).body;
	if (!Array.isArray(body)) return false;
	return body.some((node) => {
		if (!node || typeof node !== "object") return false;
		return (node as Record<string, unknown>).type === "entity_ref";
	});
}

// The shared label + `<dl>` shell every detail-body section wears (entry, person,
// project). One owner keeps the `<section>`/title/`<dl>` markup and its styling in
// a single place; callers supply only their `<Field>` rows as children.
function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<p className="text-xs font-medium tracking-normal text-muted-foreground">
				{title}
			</p>
			<dl className="flex flex-col gap-1.5 text-sm">{children}</dl>
		</section>
	);
}

function EntrySection({
	title,
	occurredAt,
	endedAt,
	bodyText,
}: {
	title: string;
	occurredAt: string;
	endedAt: string;
	bodyText: string;
}) {
	return (
		<Section title={title}>
			<Field label="Occurred" value={occurredAt || "Unknown"} />
			{endedAt ? <Field label="Ended" value={endedAt} /> : null}
			<Field label="Body" value={bodyText || "Empty"} />
		</Section>
	);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex gap-2">
			<dt className="w-20 shrink-0 text-xs font-medium text-muted-foreground">
				{label}
			</dt>
			<dd className="min-w-0 break-words text-card-foreground">{value}</dd>
		</div>
	);
}

// Resolve an entity id to a human label for the review body: the cached name if
// known, else a short id (first 8 chars) so a not-yet-cached ref still reads as an
// abbreviated handle rather than a full raw UUID.
function displayEntity(
	id: string,
	nameFor: (id: string) => string | null,
): string {
	return nameFor(id) ?? `${id.slice(0, 8)}…`;
}

// A datetime the model proposed, shown as its day slice (the review body is a
// glance, not a to-the-second audit). Empty → null so the caller skips the row.
function proposalDay(value: string): string | null {
	return value ? value.slice(0, 10) : null;
}

// Humanize a raw (unvalidated) status enum against a label map, falling back to
// the raw value for a status the map doesn't cover. Empty → empty.
function statusLabel(value: string, labels: Record<string, string>): string {
	return labels[value] ?? value;
}

// A one-line recurrence summary from a raw (snake_case, unvalidated) recurrence
// payload, reusing the same formatter the Library inspector uses. Null when the
// payload carries no well-formed rule so the caller skips the row.
function recurrenceLine(todo: unknown): string | null {
	const rule = asRecurrence(objectField(todo, "recurrence"));
	return rule ? recurrenceSummary(rule) : null;
}

// A person ref is itself unvalidated; read its id/role defensively. Returns null
// when there is no usable person_id so the caller can skip rendering a blank row.
// `nameFor` resolves the id to a display name (falling back to a short id) so the
// row never surfaces a raw UUID.
function personRefLine(
	ref: unknown,
	nameFor: (id: string) => string | null,
): string | null {
	const personId = textField(ref, "person_id");
	if (!personId) return null;
	const role = textField(ref, "role");
	const who = displayEntity(personId, nameFor);
	return role === "waiting_on" ? `Waiting on: ${who}` : `Related: ${who}`;
}

// Map an array field of (unvalidated) person refs to rendered rows. Rows are
// static and presentational, so the post-filter index is a unique, stable key —
// it avoids a duplicate-key collision when two refs share the same id + role
// (reachable since the payload is raw, unvalidated model output).
function personRefFields(
	payload: unknown,
	key: string,
	prefix: string,
	label: string,
	nameFor: (id: string) => string | null,
) {
	// Key by the row's own value plus a per-value occurrence counter rather than a
	// bare array index (Biome noArrayIndexKey): stable across payload reordering,
	// and still unique when two unvalidated refs render the identical line.
	const seen = new Map<string, number>();
	return arrayField(payload, key)
		.map((ref) => personRefLine(ref, nameFor))
		.filter((line): line is string => line !== null)
		.map((line) => {
			const nth = seen.get(line) ?? 0;
			seen.set(line, nth + 1);
			return (
				<Field key={`${prefix}:${line}:${nth}`} label={label} value={line} />
			);
		});
}

// --- renderBody strategies -------------------------------------------------
// One per PROPOSAL_VIEWS row family (journal create/update/delete share one,
// mode-gated). Each owns the full detail body — including the `border-t` divider
// the JSX fork used to wrap them in — and reads the opaque payload (and, for
// journal diffs, the review context) only through the defensive helpers above.

/** Kinds with no detail body (reference, fallback). */
export function renderNoBody(): ReactNode {
	return null;
}

/**
 * Journal create/update/delete share one two-root diff, selected by `mode`:
 * create → proposed only; update → current (if present) + proposed; delete →
 * current (or an "unavailable" note when context is absent), no proposed.
 */
export function renderJournalBody(
	{ payload, reviewContext }: ProposalBodyArgs,
	mode: "create" | "update" | "delete",
): ReactNode {
	const currentJournalEntry = reviewContext?.current_journal_entry;
	const showCurrent = mode === "update" || mode === "delete";
	const showProposed = mode === "create" || mode === "update";
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
			{showCurrent ? (
				currentJournalEntry ? (
					<EntrySection
						title="Current entry"
						occurredAt={textField(currentJournalEntry, "occurred_at")}
						endedAt={textField(currentJournalEntry, "ended_at")}
						bodyText={journalBody(currentJournalEntry)}
					/>
				) : mode === "delete" ? (
					<p className="text-muted-foreground text-sm">
						Current entry details unavailable.
					</p>
				) : null
			) : null}
			{showProposed ? (
				<EntrySection
					title="Proposed entry"
					occurredAt={textField(payload, "occurred_at")}
					endedAt={textField(payload, "ended_at")}
					bodyText={journalBody(payload)}
				/>
			) : null}
		</div>
	);
}

// One labelled `<section>` of Person `<Field>` rows, read defensively off an
// opaque body (a proposed payload OR the current entity from review_context). The
// update card stacks two of these (Current + Proposed) so a field present in the
// current body but omitted from the full-document replace stays visible (ADR-0016).
function personSection(title: string, body: unknown): ReactNode {
	const note = textField(body, "note");
	const aliases = arrayField(body, "aliases").filter(
		(a): a is string => typeof a === "string",
	);
	return (
		<Section title={title}>
			<Field label="Name" value={textField(body, "name") || "Unknown"} />
			{note ? <Field label="Note" value={note} /> : null}
			{aliases.length > 0 ? (
				<Field label="Aliases" value={aliases.join(", ")} />
			) : null}
		</Section>
	);
}

export function renderPersonBody({
	payload,
	reviewContext,
}: ProposalBodyArgs): ReactNode {
	const currentPerson = reviewContext?.current_person;
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
			{currentPerson ? (
				<>
					{personSection("Current", currentPerson)}
					{personSection("Replacing with", payload)}
				</>
			) : (
				personSection("Person", payload)
			)}
		</div>
	);
}

// One labelled `<section>` of Project `<Field>` rows (sibling of personSection).
function projectSection(title: string, body: unknown): ReactNode {
	const outcome = textField(body, "outcome");
	const status = textField(body, "status");
	const note = textField(body, "note");
	return (
		<Section title={title}>
			<Field label="Name" value={textField(body, "name") || "Unknown"} />
			{outcome ? <Field label="Outcome" value={outcome} /> : null}
			{/* Humanize the raw enum ("on_hold") to its label; fall back to raw. */}
			{status ? (
				<Field
					label="Status"
					value={statusLabel(status, PROJECT_STATUS_LABEL)}
				/>
			) : null}
			{note ? <Field label="Note" value={note} /> : null}
		</Section>
	);
}

export function renderProjectBody({
	payload,
	reviewContext,
}: ProposalBodyArgs): ReactNode {
	const currentProject = reviewContext?.current_project;
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
			{currentProject ? (
				<>
					{projectSection("Current", currentProject)}
					{projectSection("Replacing with", payload)}
				</>
			) : (
				projectSection("Project", payload)
			)}
		</div>
	);
}

// The Todo scalar-field rows shared by the create and update proposal bodies —
// title (create only, where "Untitled" is a sensible placeholder; an update omits
// an unchanged title so a blank row would mislead), note, humanized status,
// due/defer day, recurrence summary, and the project resolved to a name. Returns a
// row array so each caller composes it with its own person-ref rows; a display
// change here lands in both bodies at once (the two used to duplicate this).
function todoScalarFieldRows(
	todo: unknown,
	nameFor: (id: string) => string | null,
	opts: { includeTitle: boolean },
): ReactNode[] {
	const note = textField(todo, "note");
	const status = textField(todo, "status");
	const projectId = textField(todo, "project_id");
	const due = proposalDay(textField(todo, "due_at"));
	const defer = proposalDay(textField(todo, "defer_at"));
	const repeats = recurrenceLine(todo);
	const rows: ReactNode[] = [];
	if (opts.includeTitle)
		rows.push(
			<Field
				key="title"
				label="Title"
				value={textField(todo, "title") || "Untitled"}
			/>,
		);
	if (note) rows.push(<Field key="note" label="Note" value={note} />);
	// Humanize the raw enum ("active"/"on_hold") to the label the rest of the app
	// shows; fall back to the raw value for an unknown status.
	if (status)
		rows.push(
			<Field
				key="status"
				label="Status"
				value={statusLabel(status, TODO_STATUS_LABEL)}
			/>,
		);
	if (due) rows.push(<Field key="due" label="Due" value={due} />);
	if (defer) rows.push(<Field key="defer" label="Defer" value={defer} />);
	if (repeats)
		rows.push(<Field key="repeats" label="Repeats" value={repeats} />);
	// Resolve the project id to its name (not a raw UUID).
	if (projectId)
		rows.push(
			<Field
				key="project"
				label="Project"
				value={displayEntity(projectId, nameFor)}
			/>,
		);
	return rows;
}

export function renderCreateTodoBody({
	payload,
	nameFor,
}: ProposalBodyArgs): ReactNode {
	const todo = objectField(payload, "todo");
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
			<section className="flex flex-col gap-2">
				<p className="text-xs font-medium tracking-normal text-muted-foreground">
					Todo
				</p>
				<dl className="flex flex-col gap-1.5 text-sm">
					{todoScalarFieldRows(todo, nameFor, { includeTitle: true })}
					{personRefFields(payload, "person_refs", "ref", "People", nameFor)}
				</dl>
			</section>
		</div>
	);
}

export function renderUpdateTodoBody({
	payload,
	nameFor,
}: ProposalBodyArgs): ReactNode {
	const todo = objectField(payload, "todo");
	// Reuse the create body's scalar rows, minus title: an update omits an
	// unchanged title, and "Untitled" here would misread as a title change.
	const scalarRows = todoScalarFieldRows(todo, nameFor, {
		includeTitle: false,
	});
	const title = textField(todo, "title");
	const removeIds = arrayField(payload, "remove_person_ids").filter(
		(id): id is string => typeof id === "string",
	);
	const setRows = personRefFields(
		payload,
		"set_person_refs",
		"set",
		"Set",
		nameFor,
	);
	const addRows = personRefFields(
		payload,
		"add_person_refs",
		"add",
		"Add",
		nameFor,
	);
	// An update whose only changed fields are ones we render (date/recurrence
	// included) shows those rows; if NOTHING renders, show an explicit note rather
	// than an empty "Changes" section (the diff carries fields we don't surface, or
	// only clears — the user still needs to know the section isn't broken).
	const hasVisibleChange =
		Boolean(title) ||
		scalarRows.length > 0 ||
		setRows.length > 0 ||
		addRows.length > 0 ||
		removeIds.length > 0;
	return (
		<div className="flex flex-col gap-3 border-border border-t pt-3">
			<section className="flex flex-col gap-2">
				<p className="text-xs font-medium tracking-normal text-muted-foreground">
					Changes
				</p>
				{hasVisibleChange ? (
					<dl className="flex flex-col gap-1.5 text-sm">
						{/* The raw `todo_id` UUID was surfaced here — unreadable to a user
						    and redundant with the card's "Update Todo" heading. Show only
						    the fields that actually change. A changed title renders here
						    (verbatim, no "Untitled" placeholder); the rest come from the
						    shared scalar-row builder. */}
						{title ? <Field label="Title" value={title} /> : null}
						{scalarRows}
						{setRows}
						{addRows}
						{removeIds.length > 0 ? (
							<Field
								label="Remove"
								value={removeIds
									.map((id) => displayEntity(id, nameFor))
									.join(", ")}
							/>
						) : null}
					</dl>
				) : (
					<p className="text-muted-foreground text-sm">
						Updates fields not shown here.
					</p>
				)}
			</section>
		</div>
	);
}
