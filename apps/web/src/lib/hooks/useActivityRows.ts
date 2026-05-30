import { useMemo } from "react";
import type { AutomationRun, Proposal } from "@/data/mock/types";
import { type Bucket, classify } from "@/lib/activity";
import { useAutomationRuns } from "./useAutomationRuns.js";
import { useAutomations } from "./useAutomations.js";
import { useProposals } from "./useProposals.js";

export type EditRow = {
	kind: "edit";
	bucket: Bucket;
	at: string;
	data: Proposal;
};
export type AutomationRowT = {
	kind: "automation";
	bucket: Bucket;
	at: string;
	data: AutomationRun;
	name: string;
};
export type Row = EditRow | AutomationRowT;

export function useActivityRows(): { data: Row[] } {
	const { data: proposals } = useProposals();
	const { data: automationRuns } = useAutomationRuns();
	const { data: automations } = useAutomations();

	const rows = useMemo<Row[]>(() => {
		if (!proposals || !automationRuns || !automations) return [];
		const automationsById = new Map(automations.map((a) => [a.id, a]));
		const editRows: EditRow[] = proposals
			.filter((p) => p.appliedAt)
			.map((p) => ({
				kind: "edit",
				// biome-ignore lint/style/noNonNullAssertion: filter() above guarantees appliedAt is defined
				bucket: classify(p.appliedAt!),
				// biome-ignore lint/style/noNonNullAssertion: filter() above guarantees appliedAt is defined
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
	}, [proposals, automationRuns, automations]);

	return { data: rows };
}
