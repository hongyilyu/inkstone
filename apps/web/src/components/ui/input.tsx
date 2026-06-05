import type * as React from "react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils.js";

/**
 * Base text input: transparent fill, no chrome of its own. The surrounding
 * field (border, divider, dialog) is the caller's or SearchField's job, so this
 * stays composable. Placeholder uses `muted-foreground` to hold contrast.
 */
export const Input = forwardRef<
	HTMLInputElement,
	React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, type = "text", ...props }, ref) {
	return (
		<input
			ref={ref}
			type={type}
			className={cn(
				"w-full bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground",
				className,
			)}
			{...props}
		/>
	);
});
