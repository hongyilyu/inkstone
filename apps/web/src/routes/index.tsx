import { createFileRoute, useNavigate } from "@tanstack/react-router";
import App from "../App.js";

/**
 * `/` — the chat surface. `App` stays router-free (presentational); this route
 * wires its settings gear to navigate to `/settings/models` (ADR-0024).
 */
function ChatRoute() {
	const navigate = useNavigate();
	return <App onOpenSettings={() => navigate({ to: "/settings/models" })} />;
}

export const Route = createFileRoute("/")({
	component: ChatRoute,
});
