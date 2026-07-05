import { useState } from "react";
import type { EntityMutateParams } from "@inkstone/protocol";
import { useEntityMutation } from "./useEntityMutation.js";

/**
 * The canonical error derivation from a mutation: shows the Error message if it
 * has one, otherwise the generic fallback. The single place this ternary lives.
 */
export function deriveMutationError(error: unknown): string | null {
	if (error == null) return null;
	if (error instanceof Error && error.message) return error.message;
	return "Couldn't save. Try again.";
}

type BuildCreate<D> = { mode: "create"; draft: D };
type BuildUpdate<D, E> = { mode: "update"; existing: E; baseline: D; draft: D };

export type UseEntityDraftEditorOpts<D, E extends { id: string }> = {
	existing: E | undefined;
	draftFromVm: (e: E | undefined) => D;
	build: (
		input: BuildCreate<D> | BuildUpdate<D, E>,
	) => EntityMutateParams | null;
	onDone: (id: string) => void;
	fallbackId?: (draft: D) => string;
};

export type UseEntityDraftEditorResult<D> = {
	draft: D;
	set: <K extends keyof D>(k: K, v: D[K]) => void;
	submit: () => void;
	saving: boolean;
	error: string | null;
};

/**
 * One-stop draft-editor harness: owns the draft state, the mutation call, the
 * null-means-no-change early close, and the error rendering. Each of the five
 * editors is its field JSX plus one call to this hook.
 */
export function useEntityDraftEditor<D, E extends { id: string }>(
	opts: UseEntityDraftEditorOpts<D, E>,
): UseEntityDraftEditorResult<D> {
	const { existing, draftFromVm, build, onDone, fallbackId } = opts;
	const baseline = draftFromVm(existing);
	const [draft, setDraft] = useState<D>(baseline);
	const mutation = useEntityMutation();

	const set = <K extends keyof D>(k: K, v: D[K]) =>
		setDraft((d) => ({ ...d, [k]: v }));

	const submit = () => {
		const params = existing
			? build({ mode: "update", existing, baseline, draft })
			: build({ mode: "create", draft });
		if (params === null) {
			onDone(existing?.id ?? (fallbackId ? fallbackId(draft) : ""));
			return;
		}
		mutation.mutate(params, {
			onSuccess: (result) =>
				onDone(
					result.entity_id ??
						existing?.id ??
						(fallbackId ? fallbackId(draft) : ""),
				),
		});
	};

	const error = deriveMutationError(mutation.error);

	return { draft, set, submit, saving: mutation.isPending, error };
}
