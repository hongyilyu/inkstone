import { Check } from "lucide-react";
import { useEntityCue } from "@/store/entityCue";

/**
 * The single transient success surface for Library/GTD writes: a quiet pill that
 * reads "Created" / "Saved" / "Deleted" near the top of the content column, then
 * auto-dismisses (the store owns the timer). Mounted at the ROOT, not in
 * WorkspaceShell, because the cue must outlive the surface that triggered it — a
 * delete navigates away and unmounts the editor, and WorkspaceShell itself
 * remounts across chat↔library, either of which would tear down a shell-mounted
 * pill mid-cue. Root mount keeps it alive across both. It is the one reusable
 * cue (a later successor "next occurrence" signal and any future auto-approve
 * seam announce through `showEntityCue`, not their own toasts).
 *
 * Accessibility follows the CopyOutcome idiom: a `role="status" aria-live="polite"`
 * region carries the verb word so assistive tech announces it regardless of
 * motion. Visibility is never gated on the entrance animation — the default /
 * reduced-motion / headless state is the fully-painted static pill; only the
 * `motion-safe:animate-rise` entrance is conditional. Keying the pill on
 * `cue.key` re-triggers the entrance and re-announces a repeat verb.
 */
export function EntityCue() {
	const cue = useEntityCue();
	if (cue === null) {
		return null;
	}
	return (
		<div className="pointer-events-none fixed top-4 left-[16rem] right-0 z-50 flex justify-center">
			<div
				key={cue.key}
				data-cue-key={cue.key}
				role="status"
				aria-live="polite"
				className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground motion-safe:animate-rise"
			>
				<Check
					data-testid="entity-cue-check"
					className="size-4 text-primary"
					aria-hidden
				/>
				<span>{cue.verb}</span>
			</div>
		</div>
	);
}
