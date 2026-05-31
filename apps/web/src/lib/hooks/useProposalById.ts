import { useMemo } from "react";
import type { Proposal } from "@/data/mock/types";
import { useProposals } from "./useProposals.js";

export function useProposalById(id: string): Proposal | undefined {
	const { data } = useProposals();
	return useMemo(() => data?.find((p) => p.id === id), [data, id]);
}
