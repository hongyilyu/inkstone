/** Loading placeholder for entity lists; mirrors real row metrics (glyph + two text lines) to preview content shape. */
export function EntitySkeleton({ rows = 6 }: { rows?: number }) {
	return (
		<ul
			className="flex animate-pulse flex-col gap-1"
			aria-hidden
			data-testid="entity-skeleton"
		>
			{Array.from({ length: rows }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative placeholder list, never reordered
				<li key={i} className="flex items-center gap-3 px-3 py-2.5">
					<span className="size-8 shrink-0 rounded-lg bg-secondary/70" />
					<span className="flex min-w-0 flex-1 flex-col gap-1.5">
						<span
							className="h-3 rounded bg-secondary/70"
							style={{ width: `${55 - (i % 3) * 12}%` }}
						/>
						<span className="h-2.5 w-2/5 rounded bg-secondary/50" />
					</span>
				</li>
			))}
		</ul>
	);
}
