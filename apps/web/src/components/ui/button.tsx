import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils.js";

const buttonVariants = cva(
	"inline-flex cursor-pointer items-center whitespace-nowrap transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
	{
		variants: {
			variant: {
				ghost:
					"text-muted-foreground hover:bg-accent hover:text-accent-foreground",
				chip: "border border-input bg-transparent text-foreground/80 hover:bg-secondary/50 hover:text-foreground",
				"sidebar-item": "text-sidebar-foreground hover:bg-sidebar-accent",
				"sidebar-item-active": "bg-sidebar-accent text-sidebar-foreground",
				"primary-icon":
					"justify-center bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
				icon: "justify-center text-foreground/60 hover:bg-accent hover:text-accent-foreground",
			},
			size: {
				xs: "rounded-md px-2 py-0.5 gap-1 text-xs",
				sm: "rounded-md px-2 py-1 gap-1 text-xs font-medium",
				pill: "rounded-full px-3.5 py-1.5 gap-2 text-sm font-medium",
				row: "h-9 rounded-lg px-2 py-1 gap-2 text-sm",
				icon: "rounded-md p-1.5",
				"icon-lg": "h-11 w-11 rounded-xl",
			},
		},
		defaultVariants: { variant: "ghost", size: "sm" },
	},
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
	VariantProps<typeof buttonVariants>;

export function Button({
	className,
	variant,
	size,
	type = "button",
	...props
}: ButtonProps) {
	return (
		<button
			type={type}
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	);
}
