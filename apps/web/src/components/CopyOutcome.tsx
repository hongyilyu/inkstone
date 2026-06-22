import { Check, Copy, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** The accessible names for a copy control's three states — shared so the two
 * copy buttons can't drift apart on wording. */
export const COPY_LABEL = {
	idle: "Copy",
	copied: "Copied",
	failed: "Couldn't copy",
} as const;

/** The accessible name for the current copy state (drives the button's aria-label). */
export function copyLabel(copied: boolean, failed: boolean): string {
	return copied
		? COPY_LABEL.copied
		: failed
			? COPY_LABEL.failed
			: COPY_LABEL.idle;
}

/**
 * The visual + screen-reader payload of a copy control: the Copy→Check (success)
 * / X (failure) icon swap, plus a visually-hidden `role="status"` live region that
 * announces the outcome (an icon swap alone is a sighted-only cue; an aria-label
 * change on a text-less button is not reliably announced). Shared by every copy
 * button so the icon set, the announcement, and the wording stay in one place.
 * `testIdPrefix`, when given, tags each icon `<prefix>-{check,failed,copy}` for tests.
 */
export function CopyOutcome({
	copied,
	failed,
	className = "size-3.5",
	testIdPrefix,
}: {
	copied: boolean;
	failed: boolean;
	className?: string;
	testIdPrefix?: string;
}) {
	const tid = (suffix: string) =>
		testIdPrefix ? `${testIdPrefix}-${suffix}` : undefined;
	return (
		<>
			{copied ? (
				<Check
					data-testid={tid("check")}
					className={cn(className, "text-primary")}
					aria-hidden
				/>
			) : failed ? (
				<X
					data-testid={tid("failed")}
					className={cn(className, "text-destructive")}
					aria-hidden
				/>
			) : (
				<Copy data-testid={tid("copy")} className={className} aria-hidden />
			)}
			<span className="sr-only" role="status">
				{copied ? COPY_LABEL.copied : failed ? COPY_LABEL.failed : ""}
			</span>
		</>
	);
}
