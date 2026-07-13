import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
	extend: {
		classGroups: {
			"bg-color": [
				{
					bg: [
						"background",
						"card",
						"popover",
						"primary",
						"secondary",
						"muted",
						"accent",
						"destructive",
						"sidebar",
						"sidebar-accent",
						"chat-bg",
					],
				},
			],
			"text-color": [
				{
					text: [
						"foreground",
						"card-foreground",
						"popover-foreground",
						"primary-foreground",
						"secondary-foreground",
						"muted-foreground",
						"accent-foreground",
						"destructive-foreground",
					],
				},
			],
			"border-color": [
				{
					border: [
						"border",
						"input",
						"ring",
						"background",
						"card",
						"popover",
						"primary",
						"secondary",
						"muted",
						"accent",
						"destructive",
						"sidebar",
						"sidebar-accent",
					],
				},
			],
		},
	},
});

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
