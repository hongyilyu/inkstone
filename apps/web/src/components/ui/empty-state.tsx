import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils.js";

/**
 * Empty / first-run / error state. Teaches rather than apologising (PRODUCT.md
 * "show the state, not a spinner"): an icon, a plain-spoken line, and an
 * optional action. `tone="brand"` is the warmer first-run treatment.
 */
export function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	tone = "default",
	size = "md",
	className,
}: {
	icon: LucideIcon;
	title: string;
	description: string;
	action?: ReactNode;
	tone?: "default" | "brand" | "danger";
	size?: "md" | "lg";
	className?: string;
}) {
	return (
		<div
			className={cn(
				"mx-auto flex max-w-sm flex-col items-center text-center",
				size === "lg" ? "gap-5 py-16" : "gap-3 py-12",
				className,
			)}
		>
			<span
				className={cn(
					"flex items-center justify-center rounded-2xl",
					size === "lg" ? "size-16" : "size-12",
					tone === "brand" && "bg-primary/12 text-primary",
					tone === "danger" && "bg-destructive/12 text-destructive",
					tone === "default" && "bg-secondary text-secondary-foreground",
				)}
			>
				<Icon className={size === "lg" ? "size-7" : "size-5"} aria-hidden />
			</span>
			<div className="flex flex-col gap-1.5">
				<h3
					className={cn(
						"font-semibold text-foreground tracking-tight",
						size === "lg" ? "text-xl" : "text-base",
					)}
				>
					{title}
				</h3>
				<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
					{description}
				</p>
			</div>
			{action ? <div className="mt-1">{action}</div> : null}
		</div>
	);
}
