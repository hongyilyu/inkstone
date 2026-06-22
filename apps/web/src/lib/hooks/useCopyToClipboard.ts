import { useEffect, useRef, useState } from "react";

/** Writes text to the clipboard and flags `copied` for `resetMs`; clears the pending
 * timer on unmount. A failed write (permission denied, non-secure context, or no
 * clipboard API) sets `failed` instead of throwing into a floating promise, so the
 * UI can show an honest "couldn't copy" state rather than silently doing nothing. */
export function useCopyToClipboard(resetMs = 2000) {
	const [copied, setCopied] = useState(false);
	const [failed, setFailed] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timerRef.current !== null) clearTimeout(timerRef.current);
		};
	}, []);

	const flag = (which: "copied" | "failed") => {
		setCopied(which === "copied");
		setFailed(which === "failed");
		if (timerRef.current !== null) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => {
			setCopied(false);
			setFailed(false);
		}, resetMs);
	};

	const copy = async (text: string) => {
		try {
			if (!navigator.clipboard) throw new Error("clipboard unavailable");
			await navigator.clipboard.writeText(text);
			flag("copied");
		} catch {
			flag("failed");
		}
	};

	return { copied, failed, copy };
}
