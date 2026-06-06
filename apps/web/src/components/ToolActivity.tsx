import {
	AlertTriangle,
	BookOpen,
	Check,
	type LucideIcon,
	Wrench,
} from "lucide-react";
import type { ToolCall } from "@/store/chat";
import { cn } from "@/lib/utils.js";

/**
 * Per-tool presentation. `active` is the present-tense label shown while the
 * tool runs ("Reading thread"); `done` is the settled past-tense label. Unknown
 * tools fall back to a humanized name + a generic glyph, so a newly-registered
 * Core tool still renders sensibly before it gets an entry here.
 */
const TOOL_PRESENTATION: Record<
	string,
	{ active: string; done: string; Icon: LucideIcon }
> = {
	read_thread: {
		active: "Reading thread",
		done: "Read thread",
		Icon: BookOpen,
	},
};

function humanize(name: string): string {
	const spaced = name.replace(/[_-]+/g, " ").trim();
	if (spaced === "") return name;
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function presentation(name: string) {
	const known = TOOL_PRESENTATION[name];
	if (known) return known;
	const label = humanize(name);
	return { active: label, done: label, Icon: Wrench };
}

/**
 * Live tool-call activity within an assistant turn (ADR-0006 tool_call Run
 * Events). Renders one compact row per call. The running row carries the
 * signature lamplight glow + a slow shimmer; completed rows settle to a quiet
 * check; an errored row pairs an alert glyph with "failed". State is conveyed
 * by icon + label + a screen-reader status, never colour alone, and all motion
 * is gated behind `motion-safe` (DESIGN.md).
 */
export function ToolActivity({
	toolCalls,
}: {
	toolCalls: readonly ToolCall[];
}) {
	if (toolCalls.length === 0) return null;
	return (
		<ul
			aria-label="Tool activity"
			aria-live="polite"
			className="flex w-full flex-col gap-1.5"
		>
			{toolCalls.map((call) => (
				<ToolCallRow key={call.id} call={call} />
			))}
		</ul>
	);
}

function ToolCallRow({ call }: { call: ToolCall }) {
	const { active, done, Icon } = presentation(call.name);
	const running = call.status === "running";
	const errored = call.status === "error";
	const label = running ? active : done;

	return (
		<li
			data-testid="tool-call"
			data-status={call.status}
			className={cn(
				"relative inline-flex w-fit max-w-full items-center gap-2 overflow-hidden rounded-lg px-2.5 py-1.5 text-sm font-medium",
				"transition-colors duration-200 ease-out-quint",
				running && "bg-secondary/50 text-foreground",
				call.status === "completed" && "text-muted-foreground",
				errored && "bg-destructive/10 text-destructive",
			)}
		>
			{running && (
				<span
					aria-hidden
					className="tool-shimmer pointer-events-none absolute inset-0 motion-safe:animate-tool-shimmer motion-reduce:hidden"
				/>
			)}

			<span
				aria-hidden
				className={cn(
					"relative grid size-5 shrink-0 place-items-center rounded-full",
					running && "motion-safe:animate-tool-glow",
				)}
			>
				{errored ? (
					<AlertTriangle className="size-4" />
				) : call.status === "completed" ? (
					<Check className="size-4 motion-safe:animate-tool-pop" />
				) : (
					<Icon className="size-4 text-primary" />
				)}
			</span>

			<span aria-hidden className="relative min-w-0 truncate">{label}</span>
			{errored && (
				<span aria-hidden className="relative shrink-0 text-xs">
					failed
				</span>
			)}

			{/* Single authoritative announcement per row (the visible label +
			    "failed" are aria-hidden so they don't double-speak in the live
			    region). */}
			<span className="sr-only">
				{running
					? `${active}, in progress`
					: errored
						? `${done} failed`
						: `${done}, done`}
			</span>
		</li>
	);
}
