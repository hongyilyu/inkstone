import { cva, type VariantProps } from "class-variance-authority";
import { Search, X } from "lucide-react";
import type { Ref } from "react";
import { cn } from "@/lib/utils.js";
import { Input } from "./input.js";

const fieldVariants = cva("flex items-center gap-2", {
	variants: {
		variant: {
			box: "h-10 rounded-lg border border-input bg-card/40 px-3",
			divider: "h-10 border-b border-input",
			dialog: "gap-3 border-border border-b px-4",
		},
		tone: {
			default: "",
			sidebar: "text-sidebar-foreground",
		},
	},
	defaultVariants: { variant: "box", tone: "default" },
});

type SearchFieldProps = Omit<
	React.InputHTMLAttributes<HTMLInputElement>,
	"size"
> &
	VariantProps<typeof fieldVariants> & {
		/** Renders a clear (✕) button when there is a value; calls this on click. */
		onClear?: () => void;
		inputRef?: Ref<HTMLInputElement>;
		wrapperClassName?: string;
	};

/** Leading-icon search field: wrapper chrome is a variant (box / divider / dialog); all input props forward to the underlying Input. `tone="sidebar"` swaps colour context. */
export function SearchField({
	variant,
	tone,
	onClear,
	inputRef,
	wrapperClassName,
	className,
	value,
	...props
}: SearchFieldProps) {
	const sidebar = tone === "sidebar";
	const dialog = variant === "dialog";
	return (
		<div className={cn(fieldVariants({ variant, tone }), wrapperClassName)}>
			<Search
				className={cn(
					"size-4 shrink-0",
					sidebar ? "text-sidebar-foreground/60" : "text-muted-foreground",
				)}
				aria-hidden
			/>
			<Input
				ref={inputRef}
				value={value}
				className={cn(
					"min-w-0 flex-1",
					dialog && "h-13 py-4 text-base",
					sidebar &&
						"text-sidebar-foreground placeholder:text-sidebar-foreground/50",
					className,
				)}
				{...props}
			/>
			{onClear && value ? (
				<button
					type="button"
					aria-label="Clear search"
					onClick={onClear}
					className="shrink-0 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
				>
					<X className="size-4" aria-hidden />
				</button>
			) : null}
		</div>
	);
}
