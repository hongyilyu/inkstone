import {
	Box,
	Check,
	ListTodo,
	Loader2,
	type LucideIcon,
	Pencil,
	RotateCcw,
	User,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PendingProposal } from "@/store/chat";
import { cn } from "@/lib/utils.js";
import { Card } from "./ui/card.js";
import { Input } from "./ui/input.js";

/** The two edited-payload shapes the card builds; the wire stays opaque. */
type TodoPayload = { title: string; done: boolean; due?: string };
type PersonPayload = { name: string; note?: string };

/**
 * Per-Entity-Type presentation: how a proposed entity of `kind` is labelled,
 * iconned, and turned into an edited payload. The card edits the PRIMARY field
 * and shows the SECONDARY field(s) read-only.
 */
interface Presenter {
	/** Singular noun for the header, e.g. "todo" / "person". */
	noun: string;
	/** Plural collection name for the accept copy, e.g. "Todos" / "People". */
	collection: string;
	icon: LucideIcon;
	/** The single editable field (todo→title, person→name). */
	primary: { key: string; label: string };
	/** Read-only field(s) shown alongside (todo→due, person→note). */
	secondary: ReadonlyArray<{ key: string; label: string }>;
	/** Build the apply-in-one-step edit payload from the edited primary value. */
	buildPayload: (value: string, data: unknown) => TodoPayload | PersonPayload;
}

const PRESENTERS: Record<string, Presenter> = {
	todo: {
		noun: "todo",
		collection: "Todos",
		icon: ListTodo,
		primary: { key: "title", label: "Title" },
		secondary: [{ key: "due", label: "Due" }],
		buildPayload: (value, data) => {
			const due = field(data, "due");
			return due
				? { title: value, done: false, due }
				: { title: value, done: false };
		},
	},
	person: {
		noun: "person",
		collection: "People",
		icon: User,
		primary: { key: "name", label: "Name" },
		secondary: [{ key: "note", label: "Note" }],
		buildPayload: (value, data) => {
			const note = field(data, "note");
			return note ? { name: value, note } : { name: value };
		},
	},
};

/** The presenter for a kind; an unknown kind falls back to a generic card. */
function presenterFor(kind: string): Presenter {
	return (
		PRESENTERS[kind] ?? {
			noun: kind,
			collection: kind,
			icon: Box,
			primary: { key: "title", label: "Title" },
			secondary: [],
			buildPayload: (value) => ({ title: value, done: false }),
		}
	);
}

/** Pull a string field off the opaque proposed-entity payload, if present. */
function field(data: unknown, key: string): string | undefined {
	if (data && typeof data === "object" && key in data) {
		const v = (data as Record<string, unknown>)[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

/**
 * The interactive review card for a parked Run's pending Proposal (ADR-0016 /
 * ADR-0025). NOT a code diff — a `create` has no "before"; it shows a labelled
 * field list of the proposed entity plus the model's rationale. The footer
 * actions ration the single Ink Magenta to the primary "Add to {collection}"
 * (One Ink Rule, DESIGN.md); Edit is a chip; Dismiss is a ghost. The card is
 * Entity-Type-agnostic: a {@link Presenter} keyed by `kind` supplies the noun,
 * icon, field labels, accept copy, and edit-payload builder (todo / person
 * today; an unknown kind gets a generic fallback).
 *
 * States (PRODUCT.md "show the state"): `pending` (actions live) · `deciding`
 * (the chosen action shows a spinner + progress label, the others disabled) ·
 * `accepted` / `rejected` (collapse to a quiet decided line) · `error` (inline
 * message + retry). The decision is announced via a live region; accept/reject
 * pair an icon with a word, never colour alone.
 *
 * Edit is local-only: the chip swaps the body for an inline form (no modal,
 * product register) pre-filled from the proposed `data`. It edits the PRIMARY
 * field; secondary fields stay read-only. Save edits AND accepts in one step
 * (`onDecide("edit", editedPayload)`, ADR-0025); Cancel returns to pending.
 * Save stays the single Ink Magenta primary in the editing state (One Ink Rule).
 */
export function ProposalCard({
	proposal,
	onDecide,
}: {
	proposal: PendingProposal;
	onDecide: (
		decision: "accept" | "reject" | "edit",
		editedPayload?: TodoPayload | PersonPayload,
	) => void;
}) {
	const { status, data, rationale, kind } = proposal;
	const presenter = presenterFor(kind);
	const Icon = presenter.icon;
	const primaryValue =
		field(data, presenter.primary.key) ?? `New ${presenter.noun}`;

	// Track which action the user chose so the spinner lands on THAT button
	// while the decide is in flight (the store's `deciding` status doesn't
	// carry the decision). Reset once the decide settles (left `deciding`).
	const [inFlight, setInFlight] = useState<"accept" | "reject" | null>(null);
	useEffect(() => {
		if (proposal.status !== "deciding") setInFlight(null);
	}, [proposal.status]);
	const decide = (decision: "accept" | "reject") => {
		setInFlight(decision);
		onDecide(decision);
	};

	// The inline edit form (local-only): the Edit chip opens it pre-filled from
	// the proposed primary value; Save applies-in-one-step, Cancel returns.
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValue] = useState(primaryValue);
	const valueRef = useRef<HTMLInputElement>(null);
	const openEdit = () => {
		setEditValue(primaryValue);
		setEditing(true);
	};
	useEffect(() => {
		if (editing) valueRef.current?.focus();
	}, [editing]);
	const saveEdit = () => {
		const trimmed = editValue.trim();
		if (trimmed.length === 0) return;
		onDecide("edit", presenter.buildPayload(trimmed, data));
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
					{accepted ? `Added to ${presenter.collection}.` : "Dismissed."}
				</span>
			</Card>
		);
	}

	const deciding = status === "deciding";
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
					<Icon className="size-4" />
				</span>
				<div className="min-w-0">
					<p className="text-xs font-medium text-muted-foreground">
						Inkstone wants to add a {presenter.noun}.
					</p>
					<p className="truncate text-sm font-semibold text-card-foreground">
						{primaryValue}
					</p>
				</div>
			</header>

			{editing ? (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						saveEdit();
					}}
					className="flex flex-col gap-3 border-border border-t pt-3"
				>
					<label
						className="flex flex-col gap-1.5"
						htmlFor="proposal-edit-primary"
					>
						<span className="text-xs font-medium text-muted-foreground">
							{presenter.primary.label}
						</span>
						<Input
							id="proposal-edit-primary"
							ref={valueRef}
							value={editValue}
							onChange={(e) => setEditValue(e.target.value)}
							className="rounded-lg border border-input bg-card-surface/40 px-3 py-2 focus-visible:ring-1 focus-visible:ring-ring"
						/>
					</label>
					{presenter.secondary.map((s) => {
						const value = field(data, s.key);
						if (!value) return null;
						return (
							<label
								key={s.key}
								className="flex flex-col gap-1.5"
								htmlFor={`proposal-edit-${s.key}`}
							>
								<span className="text-xs font-medium text-muted-foreground">
									{s.label}
								</span>
								<Input
									id={`proposal-edit-${s.key}`}
									value={value}
									readOnly
									className="rounded-lg border border-input bg-card-surface/40 px-3 py-2 text-muted-foreground"
								/>
							</label>
						);
					})}
					<footer className="flex items-center gap-2 pt-1">
						<button
							type="submit"
							disabled={editValue.trim().length === 0}
							className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						>
							<Check className="size-4" aria-hidden />
							Save changes
						</button>
						<button
							type="button"
							onClick={() => setEditing(false)}
							className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
						>
							Cancel
						</button>
					</footer>
				</form>
			) : (
				<>
					<dl className="flex flex-col gap-1.5 border-border border-t pt-3 text-sm">
						<Field label={presenter.primary.label} value={primaryValue} />
						{presenter.secondary.map((s) => {
							const value = field(data, s.key);
							return value ? (
								<Field key={s.key} label={s.label} value={value} />
							) : null;
						})}
					</dl>

					{rationale ? (
						<p className="text-sm leading-relaxed text-muted-foreground">
							{rationale}
						</p>
					) : null}

					{isError ? (
						<p role="alert" className="text-sm text-destructive">
							Couldn't apply. Try again.
						</p>
					) : null}

					<footer className="flex items-center gap-2 pt-1">
						{isError ? (
							<button
								type="button"
								onClick={() => decide("accept")}
								className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
							>
								<RotateCcw className="size-4" aria-hidden />
								Try again
							</button>
						) : (
							<button
								type="button"
								disabled={deciding}
								onClick={() => decide("accept")}
								className={cn(
									"inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
								)}
							>
								{deciding && inFlight === "accept" ? (
									<>
										<Loader2
											className="size-4 motion-safe:animate-spin"
											aria-hidden
										/>
										Adding…
									</>
								) : (
									<>
										<Check className="size-4" aria-hidden />
										Add to {presenter.collection}
									</>
								)}
							</button>
						)}

						<button
							type="button"
							disabled={deciding || isError}
							onClick={openEdit}
							className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-input px-3 py-1.5 font-medium text-foreground/80 text-sm transition-colors hover:bg-secondary/50 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						>
							<Pencil className="size-3.5" aria-hidden />
							Edit
						</button>

						<button
							type="button"
							disabled={deciding}
							onClick={() => decide("reject")}
							className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						>
							{deciding && inFlight === "reject" ? (
								<>
									<Loader2
										className="size-3.5 motion-safe:animate-spin"
										aria-hidden
									/>
									Dismissing…
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
			<dt className="w-16 shrink-0 text-xs font-medium text-muted-foreground">
				{label}
			</dt>
			<dd className="min-w-0 text-card-foreground">{value}</dd>
		</div>
	);
}
