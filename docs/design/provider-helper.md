# provider-helper

Design rationale for the Provider Helper (`packages/provider-helper`), extracted from code comments — keep in sync with the source. Split out of `packages/worker` per ADR-0040.

## provider.ts — module (Provider Helper)

The Provider Helper (ADR-0023): a stateless TypeScript process Core spawns to run LLM-provider OAuth via `pi-ai`'s pure functions. It holds no durable state — it prints its result on stdout and exits; Core owns the Credential Store. The argv contract is `<mode> <provider>`: two modes, plus the provider id (Core appends it at the spawn sites). A provider outside the helper's `SUPPORTED_PROVIDERS` (today: exactly `openai-codex`) is rejected with an `error` line before any OAuth call — Core's registry coherence test (`login_allowed_providers_are_helper_supported`) keeps the registry's `login_allowed` flags inside that set. The modes:

- `refresh` — read one line `{ "refresh": "<token>" }` on stdin, rotate it via pi-ai, print one line of Core-shaped credentials.
- `login` — run pi-ai's PKCE + :1455 loopback flow; print the authorize URL line as soon as it's known, then the credentials line on success. (Orchestrated by Core in slice 8.)

Core-shaped credentials on the wire (snake_case `account_id` to match the Rust Credential Store struct):
`{ "kind": "credentials", "access", "refresh", "expires", "account_id" }`
The authorize-URL line (login only):
`{ "kind": "authorize_url", "url": "https://auth.openai.com/..." }`
On failure:
`{ "kind": "error", "message": "..." }`

These line shapes are contract-gated (ADR-0009): `ProviderHelperLine` in `packages/protocol` mirrors `HelperLine` in `crates/core/src/protocol.rs`, with shared fixtures under `tests/contract/fixtures/structs/authored/provider_helper_line.*.json` parsed by both sides. The dispatch/mapping/redaction logic lives in `helper-main.ts` behind an injected-deps seam (`runHelperMain`), unit-tested in `test/`; `provider.ts` is the thin entry wiring real pi functions and stdio.

In login mode, pi runs the :1455 loopback and opens nothing itself; it hands us the authorize URL via `onAuth`. Core relays that URL to the Web Client, which opens it in a new tab; the loopback captures the OpenAI callback. There is no interactive prompt path in the new-tab flow; the loopback callback supplies the code. If pi falls back to `onPrompt` we have no console to read, so reject — the loopback path is the supported one.

Core spawns it via the `INKSTONE_PROVIDER_HELPER_CMD` (refresh) / `INKSTONE_PROVIDER_LOGIN_CMD` (login) command-string seam; the default points at `packages/provider-helper/node_modules/.bin/tsx packages/provider-helper/src/provider.ts {mode}`, and the spawn sites append the provider id as the final argv element. Tests point the env overrides at the standalone stubs `crates/core/tests/fixtures/{refresh,login}-helper.ts` (which ignore the extra argv).
