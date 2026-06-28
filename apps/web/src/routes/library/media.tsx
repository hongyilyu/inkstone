import { createFileRoute } from "@tanstack/react-router";
import { Film } from "lucide-react";
import { StubTopic } from "@/components/library/StubTopic";

function MediaRoute() {
	return (
		<StubTopic
			title="Media"
			description="Your read/watch queue will land here once the Bookmark→Media surface ships."
			icon={Film}
			issue={252}
		/>
	);
}

export const Route = createFileRoute("/library/media")({
	component: MediaRoute,
});
