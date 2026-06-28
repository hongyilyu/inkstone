import { createFileRoute } from "@tanstack/react-router";
import { HeartPulse } from "lucide-react";
import { StubTopic } from "@/components/library/StubTopic";

function HealthRoute() {
	return (
		<StubTopic
			title="Health"
			description="Your observation streams — bodyweight, intake, exercise — will land here once the read surface ships."
			icon={HeartPulse}
			issue={253}
		/>
	);
}

export const Route = createFileRoute("/library/health")({
	component: HealthRoute,
});
