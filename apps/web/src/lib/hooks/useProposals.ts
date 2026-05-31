import { useQuery } from "@tanstack/react-query";
import { proposals } from "@/data/mock/proposals";

export function useProposals() {
	return useQuery({
		queryKey: ["proposals"],
		queryFn: async () => proposals,
		placeholderData: proposals,
	});
}
