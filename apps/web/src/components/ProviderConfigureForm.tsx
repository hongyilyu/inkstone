import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ProviderConfigureFormProps {
	/** Provider display name, e.g. "OpenRouter" — for the field hint. */
	providerLabel: string;
	/** Store the pasted key. Rejects on failure (the form surfaces the error and
	 * stays open); resolves once the key is stored (the parent closes the form). */
	onSubmit: (apiKey: string) => Promise<void>;
	onCancel: () => void;
}

/** Inline paste-key form for a key-configurable provider (ADR-0062).
 * Presentational: the parent owns the `provider/configure` call + the live
 * status refresh; this owns only the draft key, pending, and error state. */
export function ProviderConfigureForm({
	providerLabel,
	onSubmit,
	onCancel,
}: ProviderConfigureFormProps) {
	const inputId = useId();
	const [key, setKey] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState(false);

	const trimmed = key.trim();

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (trimmed.length === 0 || pending) return;
		setPending(true);
		setError(false);
		try {
			await onSubmit(trimmed);
		} catch {
			// A configure that Core rejected (bad key, helper down): surface it and
			// keep the form open so the user can retry — never crash the page.
			setError(true);
		} finally {
			setPending(false);
		}
	};

	return (
		<form
			onSubmit={submit}
			className="flex flex-col gap-2 rounded-md border border-input bg-muted/30 p-3"
		>
			<label htmlFor={inputId} className="font-medium text-sm">
				API key
			</label>
			<div className="rounded-md border border-input px-3 py-2">
				<Input
					id={inputId}
					type="password"
					autoComplete="off"
					placeholder={`Paste your ${providerLabel} API key`}
					value={key}
					onChange={(e) => {
						setKey(e.target.value);
						// Clear a prior failure as the user corrects the key — a stale
						// "couldn't save that key" alarm shouldn't linger over new input.
						if (error) setError(false);
					}}
					disabled={pending}
				/>
			</div>
			{error && (
				<p role="alert" className="text-destructive text-xs">
					Couldn't save that key. Check it and try again.
				</p>
			)}
			<div className="flex items-center gap-2">
				<Button
					type="submit"
					variant="chip"
					size="sm"
					disabled={pending || trimmed.length === 0}
				>
					{pending ? "Saving…" : "Save"}
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={pending}
					onClick={onCancel}
				>
					Cancel
				</Button>
			</div>
		</form>
	);
}
