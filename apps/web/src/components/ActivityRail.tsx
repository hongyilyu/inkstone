// VISUAL ONLY — automation rows are out of scope per ADR-0010; rendered from mock data.
import { Bot, Check, File, FileText, Folder } from "lucide-react";
import { useMemo, useState } from "react";
import {
	type AutomationRowT,
	type EditRow,
	type Row,
	useActivityRows,
} from "@/lib/hooks/useActivityRows";
import { Button } from "./ui/button.js";

type Filter = "all" | "edits" | "automations";

const KIND_ICON = {
	todo: Check,
	project: Folder,
	note: FileText,
	file: File,
} as const;

export function ActivityRail() {
	const [filter, setFilter] = useState<Filter>("all");
	const { data: allRows } = useActivityRows();

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
			className="flex flex-col gap-2 overflow-y-auto bg-sidebar p-3 pt-10 text-sm text-sidebar-foreground"
		>
			<div className="flex gap-1 text-xs">
				{(["all", "edits", "automations"] as Filter[]).map((f) => (
					<Button
						key={f}
						variant={filter === f ? "sidebar-item-active" : "sidebar-item"}
						size="xs"
						className="capitalize"
						onClick={() => setFilter(f)}
						aria-pressed={filter === f}
					>
						{f}
					</Button>
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
		<div className="flex flex-col gap-1">
			<div className="px-2 text-[11px] font-semibold tracking-wide text-sidebar-foreground/50 uppercase">
				{label}
			</div>
			{rows.length === 0 ? (
				<div className="px-2 text-xs text-sidebar-foreground/60">—</div>
			) : (
				<ul className="flex flex-col">
					{rows.map((r) => (
						<li
							key={r.data.id}
							data-row={r.kind}
							className="flex items-start rounded-md px-2 py-1 text-xs text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
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
			<Icon
				className="mt-0.5 h-3 w-3 shrink-0 text-sidebar-foreground/50"
				aria-hidden
			/>
			<div className="min-w-0 flex-1">
				<div className="truncate">{row.data.title}</div>
				<div className="truncate text-sidebar-foreground/60">
					{row.data.target} · {row.at}
				</div>
			</div>
		</div>
	);
}

function AutomationRowView({ row }: { row: AutomationRowT }) {
	return (
		<div className="flex items-start gap-1.5">
			<Bot
				className="mt-0.5 h-3 w-3 shrink-0 text-sidebar-foreground/50"
				aria-hidden
			/>
			<div className="min-w-0 flex-1">
				<div className="truncate">{row.name}</div>
				<div className="truncate text-sidebar-foreground/60">
					{row.data.summary}
				</div>
				<div className="text-[10px] text-sidebar-foreground/45">
					{row.at} · {row.data.status}
				</div>
			</div>
		</div>
	);
}
