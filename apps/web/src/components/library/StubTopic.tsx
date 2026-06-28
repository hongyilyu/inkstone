import { type LucideIcon, Sparkles } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * An honest "coming soon" topic placeholder (ADR-0054, §5): a title, a short
 * line about the surface that will land here, and a link to its tracking issue.
 * It reads NOTHING — no fake rows, no data fetch — and reserves the topic's
 * place in the nav so the real surface arrives additively, not as a re-layout.
 */
export function StubTopic({
	title,
	description,
	icon = Sparkles,
	issue,
}: {
	title: string;
	description: string;
	icon?: LucideIcon;
	/** The GitHub issue number tracking this topic's real surface. */
	issue: number;
}) {
	return (
		<section
			aria-label={title}
			className="flex h-full min-h-0 flex-col overflow-y-auto"
		>
			<div className="mx-auto w-full max-w-3xl px-6 py-12">
				<EmptyState
					icon={icon}
					tone="brand"
					title={title}
					description={description}
					action={
						<a
							href={`https://github.com/hongyilyu/inkstone/issues/${issue}`}
							target="_blank"
							rel="noreferrer"
							className="font-medium text-primary text-sm hover:underline"
						>
							{`Tracked in #${issue}`}
						</a>
					}
				/>
			</div>
		</section>
	);
}
