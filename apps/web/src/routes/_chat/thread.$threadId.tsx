import type { JsonObject } from "@inkstone/protocol";
import { createFileRoute } from "@tanstack/react-router";
import { ChatColumn } from "@/components/ChatColumn.js";
import { asString } from "@/lib/readPayload";

/** Optional within-thread scroll anchor (issue #138, ADR-0061): a ⌘K message hit
 *  deep-links to `/thread/<id>?focusedMessageId=<id>`; ChatColumn scrolls to it,
 *  highlights it, then strips the param (consume-then-strip). */
interface ThreadSearch {
	focusedMessageId?: string;
}

/** `/thread/$threadId` — the chat surface focused on one Thread (ADR-0061). `ChatColumn` reads the id from the route via `useParams`. */
export const Route = createFileRoute("/_chat/thread/$threadId")({
	validateSearch: (search: JsonObject): ThreadSearch => ({
		focusedMessageId: asString(search.focusedMessageId),
	}),
	component: ChatColumn,
});
