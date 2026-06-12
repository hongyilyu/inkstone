import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils.js";

const badgeVariants = cva(
	"inline-flex items-center gap-1 whitespace-nowrap rounded-full font-medium",
	{
		variants: {
			variant: {
				// Hairline border in the chip's own hue keeps the pill readable on low-contrast surfaces where the fill alone barely separates.
				secondary:
					"border border-secondary-foreground/25 bg-secondary text-secondary-foreground",
				primary: "bg-primary/10 text-primary",
				destructive: "bg-destructive/12 text-destructive",
			},
			size: {
				sm: "px-2 py-0.5 text-xs",
				md: "px-2.5 py-1 text-xs",
			},
		},
		defaultVariants: { variant: "secondary", size: "md" },
	},
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
	VariantProps<typeof badgeVariants>;

/** Small status / metadata pill. Always pairs colour with text (never colour alone) — see DESIGN.md. */
export function Badge({ className, variant, size, ...props }: BadgeProps) {
	return (
		<span
			className={cn(badgeVariants({ variant, size }), className)}
			{...props}
		/>
	);
}
