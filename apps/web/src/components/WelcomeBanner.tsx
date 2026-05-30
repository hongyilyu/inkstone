import { X } from "lucide-react";
import { useState } from "react";

export function WelcomeBanner() {
	const [dismissed, setDismissed] = useState(false);
	if (dismissed) return null;
	return (
		<div className="flex items-center gap-2 border-b border-border bg-accent/40 px-3 py-2 text-sm text-accent-foreground">
			<span className="flex-1">Welcome to Inkstone — start typing to begin.</span>
			<button
				type="button"
				aria-label="Dismiss welcome banner"
				onClick={() => setDismissed(true)}
				className="rounded-md p-1 hover:bg-accent"
			>
				<X
					className="h-3.5 w-3.5"
					aria-hidden
				/>
			</button>
		</div>
	);
}
