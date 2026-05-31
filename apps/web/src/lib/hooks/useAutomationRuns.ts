import { useQuery } from "@tanstack/react-query";
import { automationRuns } from "@/data/mock/automations";

export function useAutomationRuns() {
	return useQuery({
		queryKey: ["automationRuns"],
		queryFn: async () => automationRuns,
		placeholderData: automationRuns,
	});
}
