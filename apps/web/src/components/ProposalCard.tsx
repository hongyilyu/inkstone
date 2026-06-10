import {
	BookOpenText,
	CalendarDays,
	Check,
	Loader2,
	Pencil,
	RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PendingProposal } from "@/store/chat";
import { Card } from "./ui/card.js";
import { Input } from "./ui/input.js";

type JournalEntryPayload = {
	occurred_at: string;
	ended_at?: string;
	body: Array<{ type: "text"; text: string }>;
};

function textField(payload: unknown, key: string): string {
	if (payload && typeof payload === "object" && key in payload) {
		const value = (payload as Record<string, unknown>)[key];
		return typeof value === "string" ? value : "";
	}
	return "";
}

function journalBody(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const body = (payload as Record<string, unknown>).body;
	if (!Array.isArray(body)) return "";
	return body
		.map((node) => {
			if (!node || typeof node !== "object") return "";
			const record = node as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string"
				? record.text
				: "";
		})
		.join("");
}

function journalPayload(
	occurredAt: string,
	bodyText: string,
	endedAt: string,
): JournalEntryPayload {
	return {
		occurred_at: occurredAt.trim(),
		...(endedAt.trim() ? { ended_at: endedAt.trim() } : {}),
		body: [{ type: "text", text: bodyText.trim() }],
	};
}

function isLocalDateTime(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value.trim());
}

function journalPayloadIssue(
	occurredAt: string,
	bodyText: string,
	endedAt: string,
): string | null {
	const occurred = occurredAt.trim();
	const ended = endedAt.trim();
	if (!isLocalDateTime(occurred)) {
		return "occurred at must use YYYY-MM-DDTHH:MM:SS";
	}
	if (ended.length > 0 && !isLocalDateTime(ended)) {
		return "ended at must use YYYY-MM-DDTHH:MM:SS";
	}
	if (ended.length > 0 && ended < occurred) {
		// Lexicographic order matches chronological order for YYYY-MM-DDTHH:MM:SS.
		return "ended at must be after occurred at";
	}
	if (bodyText.trim().length === 0) {
		return "body must not be empty";
	}
	return null;
}

export function ProposalCard({
	proposal,
	onDecide,
}: {
	proposal: PendingProposal;
	onDecide: (
		decision: "accept" | "reject" | "edit",
		editedPayload?: JournalEntryPayload,
	) => void;
}) {
	const { status, payload, rationale, mutation_kind } = proposal;
	const occurredAt = textField(payload, "occurred_at");
	const endedAt = textField(payload, "ended_at");
	const bodyText = journalBody(payload);
	const isJournalEntry = mutation_kind === "create_journal_entry";
	const title = isJournalEntry ? "Journal Entry" : mutation_kind;
	const payloadIssue = isJournalEntry
		? journalPayloadIssue(occurredAt, bodyText, endedAt)
		: null;
	const canApply = payloadIssue === null;

	const [inFlight, setInFlight] = useState<"accept" | "reject" | "edit" | null>(
		null,
	);
	useEffect(() => {
		if (proposal.status !== "deciding") setInFlight(null);
	}, [proposal.status]);
	const decide = (decision: "accept" | "reject") => {
		setInFlight(decision);
		onDecide(decision);
	};

	const [editing, setEditing] = useState(false);
	const [editOccurredAt, setEditOccurredAt] = useState(occurredAt);
	const [editEndedAt, setEditEndedAt] = useState(endedAt);
	const [editBody, setEditBody] = useState(bodyText);
	const editIssue = isJournalEntry
		? journalPayloadIssue(editOccurredAt, editBody, editEndedAt)
		: null;
	const bodyRef = useRef<HTMLTextAreaElement>(null);
	const openEdit = () => {
		setEditOccurredAt(occurredAt);
		setEditEndedAt(endedAt);
		setEditBody(bodyText);
		setEditing(true);
	};
	useEffect(() => {
		if (editing) bodyRef.current?.focus();
	}, [editing]);
	const saveEdit = () => {
		if (inFlight !== null || proposal.status === "deciding") return;
		if (editIssue !== null) return;
		setInFlight("edit");
		setEditing(false);
		onDecide("edit", journalPayload(editOccurredAt, editBody, editEndedAt));
	};

	if (status === "accepted" || status === "rejected") {
		const accepted = status === "accepted";
		return (
			<Card
				data-proposal={proposal.run_id}
				data-proposal-status={status}
				className="flex items-center gap-2 px-4 py-2.5 text-sm text-muted-foreground motion-safe:transition-opacity motion-safe:duration-200"
			>
				{accepted ? (
					<Check className="size-4 text-card-foreground/60" aria-hidden />
				) : null}
				<span aria-live="polite">
					{accepted ? "Added to Journal." : "Dismissed."}
				</span>
			</Card>
		);
	}

	const deciding = status === "deciding";
	const submitting = deciding || inFlight !== null;
	const isError = status === "error";

	return (
		<Card
			data-proposal={proposal.run_id}
			data-proposal-status={status}
			className="flex flex-col gap-3 p-4 motion-safe:transition-opacity motion-safe:duration-200"
		>
			<header className="flex items-center gap-2.5">
				<span
					className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
					aria-hidden
				>
					<BookOpenText className="size-4" />
				</span>
				<div className="min-w-0">
					<p className="text-xs font-medium text-muted-foreground">
						Inkstone wants to create a {title}.
					</p>
					<p className="truncate text-sm font-semibold text-card-foreground">
						{bodyText || "Untitled entry"}
					</p>
				</div>
			</header>

			{editing ? (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						saveEdit();
					}}
					className="flex flex-col gap-3 border-border border-t pt-3"
				>
					<label
						className="flex flex-col gap-1.5"
						htmlFor="proposal-edit-occurred-at"
					>
						<span className="text-xs font-medium text-muted-foreground">
							Occurred at
						</span>
						<Input
							id="proposal-edit-occurred-at"
							value={editOccurredAt}
							onChange={(event) => setEditOccurredAt(event.target.value)}
							className="rounded-lg border border-input bg-card-surface/40 px-3 py-2 focus-visible:ring-1 focus-visible:ring-ring"
						/>
					</label>
					<label
						className="flex flex-col gap-1.5"
						htmlFor="proposal-edit-ended-at"
					>
						<span className="text-xs font-medium text-muted-foreground">
							Ended at
						</span>
						<Input
							id="proposal-edit-ended-at"
							value={editEndedAt}
							onChange={(event) => setEditEndedAt(event.target.value)}
							className="rounded-lg border border-input bg-card-surface/40 px-3 py-2 focus-visible:ring-1 focus-visible:ring-ring"
						/>
					</label>
					<label className="flex flex-col gap-1.5" htmlFor="proposal-edit-body">
						<span className="text-xs font-medium text-muted-foreground">
							Body
						</span>
						<textarea
							id="proposal-edit-body"
							ref={bodyRef}
							value={editBody}
							onChange={(event) => setEditBody(event.target.value)}
							className="min-h-24 rounded-lg border border-input bg-card-surface/40 px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
						/>
					</label>
					{editIssue ? (
						<p role="alert" className="text-sm text-destructive">
							Edit required fields: {editIssue}.
						</p>
					) : null}
					<footer className="flex items-center gap-2 pt-1">
						<button
							type="submit"
							disabled={submitting || editIssue !== null}
							className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						>
							<Check className="size-4" aria-hidden />
							Save changes
						</button>
						<button
							type="button"
							disabled={submitting}
							onClick={() => setEditing(false)}
							className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						>
							Cancel
						</button>
					</footer>
				</form>
			) : (
				<>
					<dl className="flex flex-col gap-1.5 border-border border-t pt-3 text-sm">
						<Field label="Occurred" value={occurredAt || "Unknown"} />
						{endedAt ? <Field label="Ended" value={endedAt} /> : null}
						<Field label="Body" value={bodyText || "Empty"} />
					</dl>

					{rationale ? (
						<p className="text-sm leading-relaxed text-muted-foreground">
							{rationale}
						</p>
					) : null}

					{isError ? (
						<p role="alert" className="text-sm text-destructive">
							{payloadIssue
								? `Edit required fields: ${payloadIssue}.`
								: "Couldn't apply. Try again."}
						</p>
					) : payloadIssue ? (
						<p role="alert" className="text-sm text-destructive">
							Edit required fields: {payloadIssue}.
						</p>
					) : null}

					<footer className="flex items-center gap-2 pt-1">
						{isError ? (
							<button
								type="button"
								disabled={!canApply}
								onClick={() => decide("accept")}
								className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							>
								<RotateCcw className="size-4" aria-hidden />
								Try again
							</button>
						) : (
							<button
								type="button"
								disabled={submitting || !canApply}
								onClick={() => decide("accept")}
								className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							>
								{deciding && inFlight === "accept" ? (
									<>
										<Loader2
											className="size-4 motion-safe:animate-spin"
											aria-hidden
										/>
										Adding...
									</>
								) : (
									<>
										<CalendarDays className="size-4" aria-hidden />
										Add Journal Entry
									</>
								)}
							</button>
						)}

						<button
							type="button"
							disabled={submitting}
							onClick={openEdit}
							className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-input px-3 py-1.5 font-medium text-foreground/80 text-sm transition-colors hover:bg-secondary/50 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						>
							<Pencil className="size-3.5" aria-hidden />
							Edit
						</button>

						<button
							type="button"
							disabled={submitting}
							onClick={() => decide("reject")}
							className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						>
							{deciding && inFlight === "reject" ? (
								<>
									<Loader2
										className="size-3.5 motion-safe:animate-spin"
										aria-hidden
									/>
									Dismissing...
								</>
							) : (
								"Dismiss"
							)}
						</button>
					</footer>
				</>
			)}
		</Card>
	);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex gap-2">
			<dt className="w-20 shrink-0 text-xs font-medium text-muted-foreground">
				{label}
			</dt>
			<dd className="min-w-0 text-card-foreground">{value}</dd>
		</div>
	);
}
