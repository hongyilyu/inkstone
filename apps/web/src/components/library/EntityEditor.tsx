import type { FormEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";

/**
 * Reusable rail-editor scaffolding (ADR-0033). A calm, inline form that lives in
 * the existing Library rail — no modal, no overlay. Slices 7-9 (Person/Project,
 * Journal) reuse this frame and the field primitives below, supplying their own
 * kind-specific body and the `onSubmit` that builds the `entity/mutate` payload.
 *
 * `EntityEditorFrame` owns the chrome: a titled header, a scrollable body, and a
 * footer with an inline error line and Cancel / Save. Per-kind editors render
 * their fields as children and report busy/error/changed state to it.
 */
export function EntityEditorFrame({
	title,
	onSubmit,
	onCancel,
	saving,
	error,
	saveLabel = "Save",
	children,
}: {
	title: string;
	onSubmit: () => void;
	onCancel: () => void;
	saving: boolean;
	error: string | null;
	saveLabel?: string;
	children: ReactNode;
}) {
	const submit = (e: FormEvent) => {
		e.preventDefault();
		// Defense-in-depth: the Save button is already disabled while saving, but a
		// stray Enter/double-submit must not fire a second mutation.
		if (saving) return;
		onSubmit();
	};
	return (
		<form onSubmit={submit} className="flex h-full flex-col">
			<header className="shrink-0 border-foreground/15 border-b px-5 py-4">
				<h2 className="font-semibold text-foreground text-lg tracking-tight">
					{title}
				</h2>
			</header>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
				{children}
			</div>
			<footer className="shrink-0 border-foreground/15 border-t px-5 py-4">
				{error ? (
					<p
						role="alert"
						className="mb-3 text-destructive text-sm leading-relaxed"
					>
						{error}
					</p>
				) : null}
				<div className="flex justify-end gap-2">
					<Button
						variant="chip"
						size="pill"
						onClick={onCancel}
						disabled={saving}
					>
						Cancel
					</Button>
					<Button type="submit" variant="primary" size="row" disabled={saving}>
						{saving ? "Saving…" : saveLabel}
					</Button>
				</div>
			</footer>
		</form>
	);
}

/** A labeled form row: the label is wired to its control via `htmlFor`/`id`. */
export function EditorField({
	label,
	htmlFor,
	children,
}: {
	label: string;
	htmlFor: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<label
				htmlFor={htmlFor}
				className="font-medium text-muted-foreground text-xs"
			>
				{label}
			</label>
			{children}
		</div>
	);
}

/** A bordered text input matching the rail's `box` field chrome (ADR-0021). */
export function EditorInput(
	props: React.InputHTMLAttributes<HTMLInputElement>,
) {
	return (
		<div className="h-10 rounded-lg border border-input bg-card/40 px-3 py-2">
			<Input {...props} />
		</div>
	);
}

/** A bordered native select — the calm, accessible picker for enum/relation fields. */
export function EditorSelect({
	children,
	...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
	return (
		<div className="h-10 rounded-lg border border-input bg-card/40 px-3">
			<select
				className="size-full bg-transparent text-foreground text-sm outline-none"
				{...props}
			>
				{children}
			</select>
		</div>
	);
}

/** A bordered multi-line note input. */
export function EditorTextarea(
	props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
	return (
		<div className="rounded-lg border border-input bg-card/40 px-3 py-2">
			<textarea
				className="min-h-16 w-full resize-y bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
				{...props}
			/>
		</div>
	);
}
