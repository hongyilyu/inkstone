// VISUAL ONLY — automation rows are out of scope per ADR-0010; rendered from mock data.
import { Bot, Check, File, FileText, Folder } from "lucide-react";
import { useMemo, useState } from "react";
import {
	type AutomationRun,
	type Proposal,
	automationRuns,
	automations,
	proposals,
} from "../data/mock.js";
import { type Bucket, classify } from "../lib/activity.js";
import { cn } from "../lib/utils.js";

type Filter = "all" | "edits" | "automations";

type EditRow = { kind: "edit"; bucket: Bucket; at: string; data: Proposal };
type AutomationRowT = {
	kind: "automation";
	bucket: Bucket;
	at: string;
	data: AutomationRun;
	name: string;
};
type Row = EditRow | AutomationRowT;

const KIND_ICON = {
	todo: Check,
	project: Folder,
	note: FileText,
	file: File,
} as const;

export function ActivityRail() {
	const [filter, setFilter] = useState<Filter>("all");

	const automationsById = useMemo(
		() => new Map(automations.map((a) => [a.id, a])),
		[],
	);

	const allRows = useMemo<Row[]>(() => {
		const editRows: EditRow[] = proposals
			.filter((p) => p.appliedAt)
			.map((p) => ({
				kind: "edit",
				bucket: classify(p.appliedAt!),
				at: p.appliedAt!,
				data: p,
			}));
		const autoRows: AutomationRowT[] = automationRuns.map((r) => ({
			kind: "automation",
			bucket: classify(r.at),
			at: r.at,
			data: r,
			name: automationsById.get(r.automationId)?.name ?? "Automation",
		}));
		return [...editRows, ...autoRows];
	}, [automationsById]);

	const filtered = useMemo(() => {
		if (filter === "edits") return allRows.filter((r) => r.kind === "edit");
		if (filter === "automations")
			return allRows.filter((r) => r.kind === "automation");
		return allRows;
	}, [allRows, filter]);

	const groups = useMemo(
		() => ({
			today: filtered.filter((r) => r.bucket === "today"),
			yesterday: filtered.filter((r) => r.bucket === "yesterday"),
			earlier: filtered.filter((r) => r.bucket === "earlier"),
		}),
		[filtered],
	);

	return (
		<aside
			aria-label="Activity"
			className="flex flex-col gap-2 overflow-y-auto bg-sidebar p-3 pt-10 text-foreground"
		>
			<div className="flex gap-1 text-xs">
				{(["all", "edits", "automations"] as Filter[]).map((f) => (
					<button
						key={f}
						type="button"
						onClick={() => setFilter(f)}
						aria-pressed={filter === f}
						className={cn(
							"rounded-md px-2.5 py-1 text-sm font-medium capitalize transition-colors",
							filter === f
								? "bg-secondary/40 text-foreground shadow-xs"
								: "bg-transparent text-muted-foreground hover:bg-sidebar-accent",
						)}
					>
						{f}
					</button>
				))}
			</div>

			<Section label="Today" rows={groups.today} />
			<Section label="Yesterday" rows={groups.yesterday} />
			<Section label="Earlier" rows={groups.earlier} />
		</aside>
	);
}

function Section({ label, rows }: { label: string; rows: Row[] }) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="px-1 text-xs font-semibold text-muted-foreground">
				{label}
			</div>
			{rows.length === 0 ? (
				<div className="px-1 text-xs text-muted-foreground">—</div>
			) : (
				<ul className="flex flex-col gap-1">
					{rows.map((r) => (
						<li
							key={r.data.id}
							data-row={r.kind}
							className="flex h-9 items-start rounded-md px-2 py-1 text-xs hover:bg-sidebar-accent"
						>
							{r.kind === "edit" ? (
								<EditRowView row={r} />
							) : (
								<AutomationRowView row={r} />
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function EditRowView({ row }: { row: EditRow }) {
	const Icon = KIND_ICON[row.data.kind];
	return (
		<div className="flex items-start gap-1.5">
			<Icon className="mt-0.5 h-3 w-3 text-muted-foreground" aria-hidden />
			<div className="min-w-0 flex-1">
				<div className="truncate font-medium text-foreground">
					{row.data.title}
				</div>
				<div className="truncate text-muted-foreground">
					{row.data.target} · {row.at}
				</div>
			</div>
		</div>
	);
}

function AutomationRowView({ row }: { row: AutomationRowT }) {
	return (
		<div className="flex items-start gap-1.5">
			<Bot className="mt-0.5 h-3 w-3 text-muted-foreground" aria-hidden />
			<div className="min-w-0 flex-1">
				<div className="truncate font-medium text-foreground">{row.name}</div>
				<div className="truncate text-muted-foreground">{row.data.summary}</div>
				<div className="text-[10px] text-muted-foreground/70">
					{row.at} · {row.data.status}
				</div>
			</div>
		</div>
	);
}
