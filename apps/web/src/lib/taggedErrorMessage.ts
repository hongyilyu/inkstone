/**
 * Duck-typed extraction of a tagged error's `message` off an `unknown` (a
 * squashed Cause or a plain rejection): returns the message iff the value
 * carries the given `_tag` and a string `message`, else undefined. Structural
 * (`_tag`), not `instanceof`, so it survives serialization/realm boundaries —
 * the same posture as {@link connectionFailureCopy}.
 */
export function taggedErrorMessage(
	error: unknown,
	tag: string,
): string | undefined {
	if (
		error !== null &&
		typeof error === "object" &&
		"_tag" in error &&
		(error as { _tag?: unknown })._tag === tag &&
		"message" in error &&
		typeof (error as { message?: unknown }).message === "string"
	) {
		return (error as { message: string }).message;
	}
	return undefined;
}
