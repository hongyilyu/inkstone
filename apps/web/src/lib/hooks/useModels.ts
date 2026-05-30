import { useQuery } from "@tanstack/react-query";
import { models } from "@/data/mock/models";

export function useModels() {
	return useQuery({
		queryKey: ["models"],
		queryFn: async () => models,
		placeholderData: models,
	});
}
