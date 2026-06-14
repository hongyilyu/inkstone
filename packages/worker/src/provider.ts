import type { OAuthCredentials } from "@earendil-works/pi-ai";
import {
	loginOpenAICodex,
	refreshOpenAICodexToken,
} from "@earendil-works/pi-ai/oauth";

// Provider Helper: stateless OAuth process Core spawns (refresh/login modes) — see docs/design/worker.md (ADR-0023)

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
	const accountId = typeof creds.accountId === "string" ? creds.accountId : "";
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
		// Never forward the SDK error verbatim — it could embed the refresh token.
		emit({ kind: "error", message: "refresh failed" });
		process.exitCode = 1;
	}
}

async function runLogin(): Promise<void> {
	// pi runs the :1455 loopback and hands us the authorize URL via onAuth; Core relays it to the Web Client.
	const creds = await loginOpenAICodex({
		onAuth: (info: { url: string; instructions?: string }) =>
			emit({ kind: "authorize_url", url: info.url }),
		// No interactive prompt in the new-tab flow; reject — the loopback path is the supported one.
		onPrompt: async () => {
			throw new Error(
				"interactive prompt not supported in the new-tab login flow",
			);
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
	emit({
		kind: "error",
		message: `unknown provider-helper mode: ${mode ?? "<none>"}`,
	});
	process.exitCode = 1;
}

main().catch(() => {
	// Never forward the thrown error verbatim — it could embed the refresh token.
	emit({ kind: "error", message: "provider helper failed" });
	process.exit(1);
});
