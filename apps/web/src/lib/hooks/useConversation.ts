import { useQuery } from "@tanstack/react-query";
import { conversation } from "@/data/mock/conversation";

export function useConversation() {
	return useQuery({
		queryKey: ["conversation"],
		queryFn: async () => conversation,
		placeholderData: conversation,
	});
}
