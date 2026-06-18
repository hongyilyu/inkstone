import {
	AlertTriangle,
	BookOpen,
	Check,
	type LucideIcon,
	Search,
	Sparkles,
	Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils.js";
import type { ToolCall } from "@/store/chat";

/** Per-tool presentation: active/done labels, glyph, and optional access tag. See docs/design/web-chat-ui.md. */
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
	search_entities: {
		active: "Searching entities",
		done: "Searched entities",
		Icon: Search,
		access: "read",
	},
	load_skill: {
		active: "Loading skill",
		done: "Loaded skill",
		Icon: Sparkles,
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

/** Most args a grouped row shows before collapsing the rest into a `+N` chip (ADR-0043). */
const MAX_VISIBLE_ARGS = 3;

/** A grouped tool-activity row (ADR-0043): repeated calls of one tool collapsed
 * into one row, except errored calls — each is its own group so the failed arg
 * is never buried in a survivors' row. `status` is the aggregate (running if any
 * member is in flight). `args` is capped at {@link MAX_VISIBLE_ARGS}; `overflow`
 * is how many more were folded away. `key` is stable across renders. */
export type ToolCallGroup = {
	key: string;
	name: string;
	status: ToolCall["status"];
	args: string[];
	overflow: number;
};

/** Collapse a turn's tool calls into grouped rows (ADR-0043). Non-errored calls
 * of the same tool merge (args deduped + joined, in first-seen order, status
 * running-if-any); each errored call breaks out into its own row. Groups are
 * ordered by first occurrence; a tool's errored break-out sorts at the position
 * of its first errored call. Shared by the live and rehydrated paths, so both
 * render identically. */
export function groupToolCalls(
	toolCalls: readonly ToolCall[],
): ToolCallGroup[] {
	const groups: ToolCallGroup[] = [];
	// Index into `groups` for the (single) mergeable group of each tool name.
	const mergeIndex = new Map<string, number>();

	for (const call of toolCalls) {
		const arg = call.arg?.trim() ? call.arg.trim() : undefined;

		// Errored calls never merge — each is its own row showing the failed arg.
		if (call.status === "error") {
			groups.push({
				key: call.id,
				name: call.name,
				status: "error",
				args: arg ? [arg] : [],
				overflow: 0,
			});
			continue;
		}

		const existingIndex = mergeIndex.get(call.name);
		if (existingIndex === undefined) {
			mergeIndex.set(call.name, groups.length);
			groups.push({
				key: `group:${call.name}`,
				name: call.name,
				status: call.status,
				args: arg ? [arg] : [],
				overflow: 0,
			});
			continue;
		}

		const group = groups[existingIndex];
		// Aggregate status: running if ANY member is still in flight.
		if (call.status === "running") group.status = "running";
		// Dedupe identical args; the count tracks the true total for `+N`.
		if (arg && !group.args.includes(arg)) group.args.push(arg);
	}

	// Apply the visible-args cap after merging, so `overflow` reflects the whole group.
	for (const group of groups) {
		if (group.args.length > MAX_VISIBLE_ARGS) {
			group.overflow = group.args.length - MAX_VISIBLE_ARGS;
			group.args = group.args.slice(0, MAX_VISIBLE_ARGS);
		}
	}

	return groups;
}

/** Live tool-call activity within an assistant turn, one compact row per tool group (ADR-0006, grouped per ADR-0043). See docs/design/web-chat-ui.md. */
export function ToolActivity({
	toolCalls,
}: {
	toolCalls: readonly ToolCall[];
}) {
	if (toolCalls.length === 0) return null;
	const groups = groupToolCalls(toolCalls);
	return (
		<ul
			aria-label="Tool activity"
			aria-live="polite"
			className="flex w-full flex-col gap-1.5"
		>
			{groups.map((group) => (
				<ToolCallRow key={group.key} group={group} />
			))}
		</ul>
	);
}

function ToolCallRow({ group }: { group: ToolCallGroup }) {
	const { active, done, Icon, access } = presentation(group.name);
	const running = group.status === "running";
	const errored = group.status === "error";
	const completed = group.status === "completed";
	const label = running ? active : done;
	const readOnly = access === "read" && !errored;
	const argText =
		group.args.length > 0
			? `${group.args.join(", ")}${group.overflow > 0 ? ` +${group.overflow}` : ""}`
			: undefined;
	const argPhrase = argText ? ` ${argText}` : "";

	const srText = running
		? `${active}${argPhrase}${access === "read" ? ", read-only" : ""}, in progress`
		: errored
			? `${done}${argPhrase} failed`
			: `${done}${argPhrase}${access === "read" ? ", read-only" : ""}, done`;

	return (
		<li
			data-testid="tool-call"
			data-status={group.status}
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
			{argText && (
				<span
					aria-hidden
					className="min-w-0 shrink truncate text-muted-foreground"
				>
					· {argText}
				</span>
			)}
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

			{/* Single authoritative announcement per row; visible labels are aria-hidden to avoid double-speak. */}
			<span className="sr-only">{srText}</span>
		</li>
	);
}
