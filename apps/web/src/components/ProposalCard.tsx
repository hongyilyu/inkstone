import { Check, ListTodo, Pencil, RotateCcw } from "lucide-react";
import type { PendingProposal } from "@/store/chat";
import { cn } from "@/lib/utils.js";
import { Card } from "./ui/card.js";

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
 * (chosen action disabled, others disabled) · `accepted` / `rejected` (collapse
 * to a quiet decided line) · `error` (inline message + retry). The decision is
 * announced via a live region; accept/reject pair an icon with a word, never
 * colour alone.
 */
export function ProposalCard({
	proposal,
	onDecide,
}: {
	proposal: PendingProposal;
	onDecide: (decision: "accept" | "reject") => void;
}) {
	const { status, data, rationale, kind } = proposal;
	const noun = KIND_NOUN[kind] ?? kind;
	const title = field(data, "title") ?? `New ${noun}`;
	const due = field(data, "due");

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
					Couldn't apply — try again.
				</p>
			) : null}

			<footer className="flex items-center gap-2 pt-1">
				{isError ? (
					<button
						type="button"
						onClick={() => onDecide("accept")}
						className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
					>
						<RotateCcw className="size-4" aria-hidden />
						Try again
					</button>
				) : (
					<button
						type="button"
						disabled={deciding}
						onClick={() => onDecide("accept")}
						className={cn(
							"inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-medium text-sm text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
						)}
					>
						<Check className="size-4" aria-hidden />
						Add to Todos
					</button>
				)}

				<button
					type="button"
					disabled
					title="Editing arrives soon"
					className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-input px-3 py-1.5 font-medium text-foreground/80 text-sm opacity-50"
				>
					<Pencil className="size-3.5" aria-hidden />
					Edit
				</button>

				<button
					type="button"
					disabled={deciding}
					onClick={() => onDecide("reject")}
					className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				>
					Dismiss
				</button>
			</footer>
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
