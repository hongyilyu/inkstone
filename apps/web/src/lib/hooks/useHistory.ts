import { useQuery } from "@tanstack/react-query";
import { history } from "@/data/mock/history";

export function useHistory() {
	return useQuery({
		queryKey: ["history"],
		queryFn: async () => history,
		placeholderData: history,
	});
}
