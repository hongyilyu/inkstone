import {
	loginOpenAICodex,
	refreshOpenAICodexToken,
} from "@earendil-works/pi-ai/oauth";
import type { OAuthCredentials } from "@earendil-works/pi-ai";

/**
 * The Provider Helper (ADR-0023): a stateless TypeScript process Core spawns
 * to run LLM-provider OAuth via `pi-ai`'s pure functions. It holds no durable
 * state — it prints its result on stdout and exits; Core owns the Credential
 * Store. Two modes, chosen by argv[2]:
 *
 *   refresh   read one line `{ "refresh": "<token>" }` on stdin, rotate it via
 *             pi-ai, print one line of Core-shaped credentials.
 *   login     run pi-ai's PKCE + :1455 loopback flow; print the authorize URL
 *             line as soon as it's known, then the credentials line on
 *             success. (Orchestrated by Core in slice 8.)
 *
 * Core-shaped credentials on the wire (snake_case `account_id` to match the
 * Rust Credential Store struct):
 *   { "kind": "credentials", "access", "refresh", "expires", "account_id" }
 * The authorize-URL line (login only):
 *   { "kind": "authorize_url", "url": "https://auth.openai.com/..." }
 * On failure:
 *   { "kind": "error", "message": "..." }
 */

const emit = (obj: unknown): void => {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
};

/** Map pi's OAuthCredentials (camelCase accountId) to Core's wire shape. */
function toCoreCredentials(creds: OAuthCredentials): {
	kind: "credentials";
	access: string;
	refresh: string;
	expires: number;
	account_id: string;
} {
	const accountId =
		typeof creds.accountId === "string" ? creds.accountId : "";
	return {
		kind: "credentials",
		access: creds.access,
		refresh: creds.refresh,
		expires: creds.expires,
		account_id: accountId,
	};
}

function readFirstLine(): Promise<string | null> {
	return new Promise((resolve) => {
		let buf = "";
		let done = false;
		const finish = (v: string | null): void => {
			if (done) return;
			done = true;
			resolve(v);
		};
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => {
			buf += chunk;
			const nl = buf.indexOf("\n");
			if (nl >= 0) finish(buf.slice(0, nl));
		});
		process.stdin.on("end", () => finish(buf.length > 0 ? buf : null));
		process.stdin.on("error", () => finish(null));
	});
}

async function runRefresh(): Promise<void> {
	const line = await readFirstLine();
	if (line === null) {
		emit({ kind: "error", message: "refresh: no input on stdin" });
		process.exitCode = 1;
		return;
	}
	const { refresh } = JSON.parse(line) as { refresh: string };
	try {
		const rotated = await refreshOpenAICodexToken(refresh);
		emit(toCoreCredentials(rotated));
	} catch {
		// Defensive: never forward a provider/SDK error verbatim — it could
		// embed the refresh token. Emit a generic, token-free message.
		emit({ kind: "error", message: "refresh failed" });
		process.exitCode = 1;
	}
}

async function runLogin(): Promise<void> {
	// pi runs the :1455 loopback + opens nothing itself; it hands us the
	// authorize URL via onAuth. Core relays that URL to the Web Client, which
	// opens it in a new tab; the loopback captures the OpenAI callback.
	const creds = await loginOpenAICodex({
		onAuth: (info: { url: string; instructions?: string }) =>
			emit({ kind: "authorize_url", url: info.url }),
		// No interactive prompt path in the new-tab flow; the loopback
		// callback supplies the code. If pi falls back to onPrompt we have no
		// console to read, so reject — the loopback path is the supported one.
		onPrompt: async () => {
			throw new Error("interactive prompt not supported in the new-tab login flow");
		},
	});
	emit(toCoreCredentials(creds));
}

async function main(): Promise<void> {
	const mode = process.argv[2];
	if (mode === "refresh") {
		await runRefresh();
		return;
	}
	if (mode === "login") {
		await runLogin();
		return;
	}
	emit({ kind: "error", message: `unknown provider-helper mode: ${mode ?? "<none>"}` });
	process.exitCode = 1;
}

main().catch(() => {
	// Token-free generic error — a thrown SDK/parse error could embed the
	// refresh token, so never forward its message verbatim.
	emit({ kind: "error", message: "provider helper failed" });
	process.exit(1);
});
