import type * as React from "react";
import { cn } from "@/lib/utils.js";

/** Content surface (rounded-xl, hairline border, card fill). Pure primitive — caller sets padding/opacity via `className`. Never nest Cards. */
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
