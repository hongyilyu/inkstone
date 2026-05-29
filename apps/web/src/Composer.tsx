import { type FormEvent, useState } from "react";

export function Composer({ onSend }: { onSend: (prompt: string) => void }) {
	const [value, setValue] = useState("");
	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const trimmed = value.trim();
		if (trimmed.length === 0) return;
		onSend(trimmed);
		setValue("");
	};
	return (
		<form className="composer" onSubmit={handleSubmit}>
			<input
				type="text"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				aria-label="prompt"
			/>
			<button type="submit">Send</button>
		</form>
	);
}
