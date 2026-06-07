import { Check, ListTodo, Loader2, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PendingProposal } from "@/store/chat";
import { cn } from "@/lib/utils.js";
import { Card } from "./ui/card.js";
import { Input } from "./ui/input.js";

/** A human label for an entity kind (todo → "todo"); falls back to the raw kind. */
const KIND_NOUN: Record<string, string> = { todo: "todo" };

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
 * actions ration the single Ink Magenta to the primary "Add to Todos" (One Ink
 * Rule, DESIGN.md); Edit is a chip (wired in slice 10); Dismiss is a ghost.
 *
 * States (PRODUCT.md "show the state"): `pending` (actions live) · `deciding`
 * (the chosen action shows a spinner + progress label, the others disabled) ·
 * `accepted` / `rejected` (collapse to a quiet decided line) · `error` (inline
 * message + retry). The decision is announced via a live region; accept/reject
 * pair an icon with a word, never colour alone.
 *
 * Edit is local-only: the chip swaps the body for an inline form (no modal,
 * product register) pre-filled from the proposed `data`. Save edits AND accepts
 * in one step (`onDecide("edit", editedPayload)`, ADR-0025); Cancel returns to
 * pending. Save stays the single Ink Magenta primary in the editing state (One
 * Ink Rule).
 */
export function ProposalCard({
	proposal,
	onDecide,
}: {
	proposal: PendingProposal;
	onDecide: (
		decision: "accept" | "reject" | "edit",
		editedPayload?: { title: string; done: boolean; due?: string },
	) => void;
}) {
	const { status, data, rationale, kind } = proposal;
	const noun = KIND_NOUN[kind] ?? kind;
	const title = field(data, "title") ?? `New ${noun}`;
	const due = field(data, "due");

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
	// the proposed values; Save applies-in-one-step, Cancel returns to pending.
	const [editing, setEditing] = useState(false);
	const [editTitle, setEditTitle] = useState(title);
	const titleRef = useRef<HTMLInputElement>(null);
	const openEdit = () => {
		setEditTitle(title);
		setEditing(true);
	};
	useEffect(() => {
		if (editing) titleRef.current?.focus();
	}, [editing]);
	const saveEdit = () => {
		const trimmed = editTitle.trim();
		if (trimmed.length === 0) return;
		onDecide("edit", { title: trimmed, done: false, ...(due ? { due } : {}) });
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
					{accepted ? "Added to Todos." : "Dismissed."}
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
					<ListTodo className="size-4" />
				</span>
				<div className="min-w-0">
					<p className="text-xs font-medium text-muted-foreground">
						Inkstone wants to add a {noun}.
					</p>
					<p className="truncate text-sm font-semibold text-card-foreground">
						{title}
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
					<label className="flex flex-col gap-1.5" htmlFor="proposal-edit-title">
						<span className="text-xs font-medium text-muted-foreground">
							Title
						</span>
						<Input
							id="proposal-edit-title"
							ref={titleRef}
							value={editTitle}
							onChange={(e) => setEditTitle(e.target.value)}
							className="rounded-lg border border-input bg-card-surface/40 px-3 py-2 focus-visible:ring-1 focus-visible:ring-ring"
						/>
					</label>
					{due ? (
						<label className="flex flex-col gap-1.5" htmlFor="proposal-edit-due">
							<span className="text-xs font-medium text-muted-foreground">
								Due
							</span>
							<Input
								id="proposal-edit-due"
								value={due}
								readOnly
								className="rounded-lg border border-input bg-card-surface/40 px-3 py-2 text-muted-foreground"
							/>
						</label>
					) : null}
					<footer className="flex items-center gap-2 pt-1">
						<button
							type="submit"
							disabled={editTitle.trim().length === 0}
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
						<Field label="Title" value={title} />
						{due ? <Field label="Due" value={due} /> : null}
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
										Add to Todos
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
