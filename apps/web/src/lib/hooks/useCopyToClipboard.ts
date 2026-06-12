import { useEffect, useRef, useState } from "react";

/** Writes text to the clipboard and flags `copied` for `resetMs`; clears the pending timer on unmount. */
export function useCopyToClipboard(resetMs = 2000) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timerRef.current !== null) clearTimeout(timerRef.current);
		};
	}, []);

	const copy = async (text: string) => {
		await navigator.clipboard.writeText(text);
		setCopied(true);
		if (timerRef.current !== null) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => setCopied(false), resetMs);
	};

	return { copied, copy };
}
