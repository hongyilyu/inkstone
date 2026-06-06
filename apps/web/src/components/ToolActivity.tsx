import {
	AlertTriangle,
	BookOpen,
	Check,
	type LucideIcon,
	Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils.js";
import type { ToolCall } from "@/store/chat";

/**
 * Per-tool presentation. `active` is the present-tense label shown while the
 * tool runs ("Reading thread"); `done` is the settled past-tense label.
 * `access` records what the tool is allowed to touch: `read` tools only observe
 * durable state (writes never run live — they surface as a reviewable Proposal,
 * the "approval is sacred" contract), so the row says so. Unknown tools fall
 * back to a humanized name + a generic glyph and make NO access claim, so a
 * newly-registered Core tool still renders sensibly (and honestly) before it
 * gets an entry here.
 */
type ToolPresentation = {
	active: string;
	done: string;
	Icon: LucideIcon;
	access?: "read";
};

const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
	read_thread: {
		active: "Reading this thread",
		done: "Read this thread",
		Icon: BookOpen,
		access: "read",
	},
};

function humanize(name: string): string {
	const spaced = name.replace(/[_-]+/g, " ").trim();
	if (spaced === "") return name;
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function presentation(name: string): ToolPresentation {
	const known = TOOL_PRESENTATION[name];
	if (known) return known;
	const label = humanize(name);
	return { active: label, done: label, Icon: Wrench };
}

/**
 * Live tool-call activity within an assistant turn (ADR-0006 tool_call Run
 * Events). Renders one compact row per call. The running row carries the
 * signature lamplight glow on its glyph; completed rows settle to a quiet
 * check; an errored row pairs an alert glyph with "failed". Read-only tools
 * say so, so the user can see the agent only observed. State is conveyed by
 * icon + label + a screen-reader status, never colour alone, and all motion is
 * gated behind `motion-safe` (DESIGN.md).
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
	const { active, done, Icon, access } = presentation(call.name);
	const running = call.status === "running";
	const errored = call.status === "error";
	const completed = call.status === "completed";
	const label = running ? active : done;
	const readOnly = access === "read" && !errored;

	const srText = running
		? `${active}${access === "read" ? ", read-only" : ""}, in progress`
		: errored
			? `${done} failed`
			: `${done}${access === "read" ? ", read-only" : ""}, done`;

	return (
		<li
			data-testid="tool-call"
			data-status={call.status}
			className={cn(
				"inline-flex w-fit max-w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium",
				"transition-colors duration-200 ease-out-quint",
				running && "bg-secondary/50 text-foreground",
				completed && "text-muted-foreground",
				errored && "bg-destructive/10 text-destructive",
			)}
		>
			<span
				aria-hidden
				className="relative grid size-5 shrink-0 place-items-center rounded-full"
			>
				{running && (
					<span className="tool-glow pointer-events-none absolute inset-0 rounded-full motion-safe:animate-tool-glow" />
				)}
				{errored ? (
					<AlertTriangle className="relative size-4" />
				) : completed ? (
					<Check className="relative size-4 motion-safe:animate-tool-pop" />
				) : (
					<Icon className="relative size-4 text-tool-glyph" />
				)}
			</span>

			<span aria-hidden className="min-w-0 truncate">
				{label}
			</span>
			{readOnly && (
				<span aria-hidden className="shrink-0 text-muted-foreground text-xs">
					· read-only
				</span>
			)}
			{errored && (
				<span aria-hidden className="shrink-0 text-xs">
					failed
				</span>
			)}

			{/* Single authoritative announcement per row (the visible label,
			    read-only tag, and "failed" are aria-hidden so they don't
			    double-speak in the live region). */}
			<span className="sr-only">{srText}</span>
		</li>
	);
}
