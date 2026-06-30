# Provider auth-kind abstraction: OAuth-with-rotation vs. static API key

Status: Accepted
/ supersedes in part [ADR-0023 (provider OAuth, core-owned credentials)](./0023-provider-oauth-core-owned-credentials.md)
/ amends [ADR-0024 (user-configurable model and effort)](./0024-user-configurable-model-and-effort.md)

Adding OpenRouter as a second LLM provider forces a decision the single-provider
design never had to make: **inkstone's whole provider machinery is OAuth-shaped.**
The Credential Store holds `{access, refresh, expires, account_id}` (ADR-0023);
`resolve_access_token` exists only to refresh-and-rotate a ChatGPT token under a
single-flight lock; `provider/login_start` runs a PKCE flow on a fixed loopback
port. OpenRouter has none of that: it authenticates with **one static API key**,
no refresh, no rotation, no account id, no login redirect. The user pastes a key;
it stays valid until they rotate it themselves.

This ADR records how a provider's **auth kind** — OAuth-with-rotation vs.
static-key — is modelled once, so Core can own credential bytes for both without
the OAuth path leaking into the static-key path or vice versa. It is hard to
reverse (it reshapes the on-disk Credential Store and the `provider/*` verb set),
surprising without context (the obvious "every provider logs in" path is
explicitly rejected), and the result of a real trade-off (a tagged credential
enum vs. a second parallel store).

## Decision

1. **The stored credential is a tagged enum, one variant per auth kind.** The flat
   `Credentials` struct (`crates/core/src/credentials.rs`) becomes:

   ```rust
   #[serde(tag = "kind", rename_all = "snake_case")]
   enum StoredCredential {
       Oauth { access: String, refresh: String, expires: i64, account_id: String },
       ApiKey { key: String },
   }
   ```

   Both variants serialize to the same `0600` per-provider JSON file in the same
   `0700` directory beside `db.sqlite`. Core stays the **single writer** — the
   ADR-0023 invariant ("Core owns the credential bytes, no file-locking needed")
   is preserved, not superseded. `openai-codex.json` holds `Oauth`;
   `openrouter.json` holds `ApiKey`.

2. **`resolve_access_token` dispatches by auth kind, not by hardcoded provider id.**
   - `Oauth`: the existing path — return the access token if valid, else refresh
     once under the single-flight lock and persist the rotation. Unchanged.
   - `ApiKey`: return the stored key as `Some(key)`. No refresh, no lock, no
     helper spawn — a static key never rotates.
   - No stored credential: `None` (the Run proceeds tokenless; the provider call
     fails with an auth error, prompting the user to connect).

   The single-flight refresh machinery stays **OAuth-only**; the static-key arm
   never touches it.

3. **The key reuses the existing manifest seam — no wire fork per provider.** A
   resolved API key flows through the same `WorkerManifest.access_token` →
   pi-ai `apiKey` channel the OAuth access token already uses
   (`packages/worker/src/interpreter.ts`). pi-ai's `applyAuth` takes an explicit
   per-request `apiKey` and it wins over any ambient/stored resolution
   (`pi/packages/ai/src/models.ts` — `apiKey = options?.apiKey ?? auth.apiKey`),
   so an OpenRouter `openai-completions` model authenticates from the manifest
   key with **zero Worker call-path change**. The manifest field stays named
   `access_token` and stays a single optional short-lived secret; it is not
   widened or renamed per provider.

4. **A new non-OAuth verb sets a static key; `login_start` stays OAuth-only.**
   `provider/configure` (params `{ provider, api_key }`) writes an `ApiKey`
   credential for a provider whose auth kind is static-key, returning the updated
   `provider/status`. `provider/login_start` continues to reject any provider
   that is not OAuth — OpenRouter never binds the `:1455` loopback.

5. **`provider/status` reports per-provider connection, computed from the store.**
   A provider is `connected` when its credential file is present and parseable —
   for OpenRouter, that means a stored key; for codex, a stored OAuth credential
   (expiry is not consulted — an expired OAuth credential is still "connected",
   it refreshes). There is **no ambient-environment probe**: a provider lights up
   only after the user explicitly connects it. (Reusing an ambient
   `OPENROUTER_API_KEY` env var without an explicit configure is deferred — see
   Consequences.)

## Consequences

- **Core owns bytes for every provider, uniformly.** The 0600 single-writer
  discipline (ADR-0023) now covers static keys too; no second storage mechanism,
  no env-file scraping. A reader of `credentials/` sees one tagged file per
  connected provider.
- **The OAuth hot path is untouched.** Refresh, rotation, the single-flight lock,
  the Provider Helper (ADR-0040) all stay exactly as-is and serve codex only —
  the enum match keeps the static-key path from ever entering them.
- **The Worker stays a generic interpreter (ADR-0018).** No provider branching in
  `interpreter.ts`; the key rides the same field the token does. This is the
  payoff of choosing the manifest seam over a per-provider credential blob.
- **Cost accepted: the on-disk credential shape changes.** Pre-release, this is a
  destructive edit — an old flat `openai-codex.json` is nuked and re-created on
  next login (CLAUDE.md §5). No compatibility shim.
- **Cost accepted: a static key is stored at rest.** It sits in the same 0600
  file an OAuth refresh token already does, so the trust surface is unchanged —
  but unlike a short-lived access token, the key is long-lived. Mitigated only by
  file mode; documented, not encrypted (single-user local-first, ADR-0007).
- **Deferred: ambient `OPENROUTER_API_KEY` / AWS-style env auth.** pi-ai would
  honor an ambient key, but auto-lighting a provider from the environment needs a
  Core-side probe to avoid a green status that fails at request time. Out of scope
  here; a provider connects only via explicit `provider/configure`.

## Related

- [ADR-0023](./0023-provider-oauth-core-owned-credentials.md) — Core-owned
  credentials; this ADR generalizes its OAuth-only `Credentials` into a tagged
  enum while preserving the single-writer / 0600 invariant.
- [ADR-0024](./0024-user-configurable-model-and-effort.md) — model/effort
  settings; amended so the active **provider is derived from the selected model**
  (the catalog is provider-keyed and model ids do not collide across providers),
  rather than read from the Workflow TOML default.
- [ADR-0040](./0040-provider-helper-own-package.md) — the OAuth Provider Helper;
  unchanged, and explicitly bypassed by the static-key path.
- [ADR-0049](./0049-provider-connected-notification.md) — the live status-refresh
  channel; `provider/configure` success fires the same chokepoint a login does.
- [ADR-0018](./0018-workflow-and-tools-definition.md) — the generic interpreter
  the manifest-seam reuse keeps provider-agnostic.
