import { createFileRoute } from "@tanstack/react-router";
import { ChatColumn } from "@/components/ChatColumn.js";

/** `/thread/$threadId` — the chat surface focused on one Thread (ADR-0042). `ChatColumn` reads the id from the route via `useParams`. */
export const Route = createFileRoute("/_chat/thread/$threadId")({
	component: ChatColumn,
});
