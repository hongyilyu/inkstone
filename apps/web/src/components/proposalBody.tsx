import type { JsonValue, ProposalReviewContext } from "@inkstone/protocol";
import type { ReactNode } from "react";
import { PROJECT_STATUS_LABEL } from "@/lib/libraryItems";
import {
	asObject,
	asString,
	readArray,
	readString,
	readStringArray,
} from "@/lib/readPayload";

/**
 * Inputs a row's `renderBody` strategy reads to draw the card's detail body — the
 * opaque wire `payload` and the optional review context (the latter carries the
 * current Journal Entry for update/delete diffs). Both are read through the
 * defensive helpers, never a typed decode (ADR-0009/0014).
 */
export interface ProposalBodyArgs {
	payload: JsonValue;
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
export function journalBody(payload: JsonValue | undefined): string {
	return readArray(payload, "body")
		.map((node) => {
			const record = asObject(node);
			if (record?.type === "entity_ref") return "[entity_ref]";
			return record?.type === "text" ? (asString(record.text) ?? "") : "";
		})
		.join("");
}

/** Whether a Journal Entry body carries any `entity_ref` node (gates the inline
 * Edit affordance — a woven body is not re-editable as plain prose). */
export function journalBodyHasEntityRef(
	payload: JsonValue | undefined,
): boolean {
	return readArray(payload, "body").some(
		(node) => asObject(node)?.type === "entity_ref",
	);
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

// Humanize a raw (unvalidated) status enum against a label map, falling back to
// the raw value for a status the map doesn't cover. Empty → empty.
function statusLabel(value: string, labels: Record<string, string>): string {
	return labels[value] ?? value;
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
						occurredAt={readString(currentJournalEntry, "occurred_at")}
						endedAt={readString(currentJournalEntry, "ended_at")}
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
					occurredAt={readString(payload, "occurred_at")}
					endedAt={readString(payload, "ended_at")}
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
function personSection(title: string, body: JsonValue | undefined): ReactNode {
	const note = readString(body, "note");
	const aliases = readStringArray(body, "aliases");
	return (
		<Section title={title}>
			<Field label="Name" value={readString(body, "name") || "Unknown"} />
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
function projectSection(title: string, body: JsonValue | undefined): ReactNode {
	const outcome = readString(body, "outcome");
	const status = readString(body, "status");
	const note = readString(body, "note");
	return (
		<Section title={title}>
			<Field label="Name" value={readString(body, "name") || "Unknown"} />
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
