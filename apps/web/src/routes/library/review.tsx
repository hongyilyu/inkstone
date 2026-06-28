import { createFileRoute, redirect } from "@tanstack/react-router";

// Retired flat-era workflow route (ADR-0054): the Review view is now a GTD filter.
export const Route = createFileRoute("/library/review")({
	beforeLoad: () => {
		throw redirect({ to: "/library/gtd", search: { filt: "review" } });
	},
});
