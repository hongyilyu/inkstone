/**
 * Exhaustiveness guard for a closed union's `switch`/ternary: the `default`/`else`
 * arm calls this, and the `value: never` param makes a newly-added variant a compile
 * error there until it's handled. Throws if somehow reached at runtime (a wire value
 * outside the union). `label` names the discriminated dimension in that message.
 *
 * A dependency-free LEAF on purpose — pure modules (e.g. `libraryFacets`, the facet
 * engine that imports no React/styling) can share it without pulling in `utils.ts`'s
 * `clsx`/`tailwind-merge` styling deps.
 */
export function assertNever(value: never, label = "value"): never {
	throw new Error(`Unhandled ${label}: ${JSON.stringify(value)}`);
}
