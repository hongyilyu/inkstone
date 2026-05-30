import { useQuery } from "@tanstack/react-query";
import { automations } from "@/data/mock/automations";

export function useAutomations() {
	return useQuery({
		queryKey: ["automations"],
		queryFn: async () => automations,
		placeholderData: automations,
	});
}
