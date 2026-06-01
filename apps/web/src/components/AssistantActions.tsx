import { CheckCircle2, Edit3, Eye, Search } from "lucide-react";
import type { MockChatMessage } from "@/data/mock/types";
import { Button } from "./ui/button.js";

const ICON = {
	read: Eye,
	search: Search,
	write: Edit3,
	decide: CheckCircle2,
} as const;

type AssistantMessage = Extract<MockChatMessage, { role: "assistant" }>;

export function AssistantActions({
	actions,
}: {
	actions: AssistantMessage["actions"];
}) {
	if (!actions) return null;
	return (
		<div className="flex flex-wrap gap-1">
			{actions.map((a, i) => {
				const I = ICON[a.kind];
				return (
					<Button key={i} variant="ghost" size="xs" data-action={a.kind}>
						<I className="h-3 w-3" aria-hidden />
						<span>{a.label}</span>
					</Button>
				);
			})}
		</div>
	);
}
