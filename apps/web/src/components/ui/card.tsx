import type * as React from "react";
import { cn } from "@/lib/utils.js";

/**
 * A content surface: rounded-xl, hairline border, card fill. A pure surface
 * primitive — padding and background opacity are set by the caller via
 * `className` (e.g. `p-5`, `bg-card/50`) so one component covers review
 * containers, proposal cards, and provider rows. Never nest Cards.
 */
export function Card({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn(
				"rounded-xl border border-border bg-card text-card-foreground",
				className,
			)}
			{...props}
		/>
	);
}
