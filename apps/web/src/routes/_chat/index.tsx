import { createFileRoute } from "@tanstack/react-router";
import { ChatColumn } from "@/components/ChatColumn.js";

/** `/` — the chat surface with no Thread focused: the new-chat welcome (ADR-0061). */
export const Route = createFileRoute("/_chat/")({
	component: ChatColumn,
});
