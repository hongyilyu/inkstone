import { useQuery } from "@tanstack/react-query";
import { currentRun } from "@/data/mock/run";

export function useCurrentRun() {
	return useQuery({
		queryKey: ["currentRun"],
		queryFn: async () => currentRun,
		placeholderData: currentRun,
	});
}
