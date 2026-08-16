import { createFileRoute } from "@tanstack/react-router";
import { TasksView } from "@/components/library/TasksView";
import { useTickTick } from "@/lib/hooks/useTickTick";

// The hidden Tasks surface (external-task-views S2). Reachable only by URL
// (/library/tasks), deliberately NOT linked in TopicNav — the dev flag until
// the S4 cutover promotes GTD → Tasks. The route owns the reconnect protocol
// (via useTickTick); TasksView is the pure presentation.
function TasksRoute() {
	const view = useTickTick();
	return <TasksView {...view} />;
}

export const Route = createFileRoute("/library/tasks")({
	component: TasksRoute,
});
