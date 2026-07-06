// provider/*, model/catalog, and settings/* wire schemas
// (ADR-0009 hand-mirror).

import { Schema as S } from "effect";

/** `provider/connected` Notification: Core pushes `{provider}` when the detached credential-drain task persists the rotated OAuth credentials, so the Settings → Models card flips to Connected live without a focus refetch (ADR-0047 second consumer, ADR-0049). */
export const ProviderConnectedNotification = S.Struct({
	provider: S.String,
});

export type ProviderConnectedNotification = S.Schema.Type<
	typeof ProviderConnectedNotification
>;

// provider/* (ADR-0023, ADR-0014 amendment): LLM-provider connection.

/** How a provider authenticates (ADR-0062): OAuth browser login vs a pasted
 * static API key. Carried on each `provider/status` row so the Web branches
 * Connect-vs-Configure off the wire rather than guessing from the id. */
export const ProviderAuthKind = S.Literal("oauth", "api_key");

export type ProviderAuthKind = S.Schema.Type<typeof ProviderAuthKind>;

/** One provider's connection state in `provider/status`. `auth_kind` (ADR-0062)
 * comes from Core's provider registry. */
export const ProviderStatus = S.Struct({
	id: S.String,
	connected: S.Boolean,
	auth_kind: ProviderAuthKind,
});

export type ProviderStatus = S.Schema.Type<typeof ProviderStatus>;

/** `provider/status` result: connection state of each known provider. */
export const ProviderStatusResult = S.Struct({
	providers: S.Array(ProviderStatus),
});

export type ProviderStatusResult = S.Schema.Type<typeof ProviderStatusResult>;

/** `provider/configure` params (ADR-0062): store a static API key for a
 * key-configurable provider (e.g. OpenRouter). The result is the refreshed
 * {@link ProviderStatusResult}. */
export const ProviderConfigureParams = S.Struct({
	provider: S.String,
	api_key: S.String,
});

export type ProviderConfigureParams = S.Schema.Type<
	typeof ProviderConfigureParams
>;

/** `provider/login_start` params: which provider to begin an OAuth login for. */
export const ProviderLoginStartParams = S.Struct({ provider: S.String });

export type ProviderLoginStartParams = S.Schema.Type<
	typeof ProviderLoginStartParams
>;

/** `provider/login_start` result: the authorize URL to open in a new tab. */
export const ProviderLoginStartResult = S.Struct({ authorize_url: S.String });

export type ProviderLoginStartResult = S.Schema.Type<
	typeof ProviderLoginStartResult
>;

/** `provider/test` params (ADR-0062): probe whether a provider actually answers, using the given model. Spawns a one-shot ephemeral Worker; nothing is persisted. */
export const ProviderTestParams = S.Struct({
	provider: S.String,
	model: S.String,
});

export type ProviderTestParams = S.Schema.Type<typeof ProviderTestParams>;

/** `provider/test` result: whether the provider answered (`alive`), with an optional failure `message` when it did not. */
export const ProviderTestResult = S.Struct({
	alive: S.Boolean,
	message: S.optional(S.String),
});

export type ProviderTestResult = S.Schema.Type<typeof ProviderTestResult>;

// model/catalog (ADR-0024): the models available per provider, hand-mirrored from pi-ai's MODELS and guarded by a Worker-side drift test.

/** One model in `model/catalog`. `input` is the modality list (`text`/`image`). */
export const ModelInfo = S.Struct({
	id: S.String,
	name: S.String,
	reasoning: S.Boolean,
	input: S.Array(S.String),
});

export type ModelInfo = S.Schema.Type<typeof ModelInfo>;

/** One provider's model group in `model/catalog`. */
export const ProviderModels = S.Struct({
	id: S.String,
	label: S.String,
	models: S.Array(ModelInfo),
});

export type ProviderModels = S.Schema.Type<typeof ProviderModels>;

/** `model/catalog` result: the models available per provider. */
export const ModelCatalogResult = S.Struct({
	providers: S.Array(ProviderModels),
});

export type ModelCatalogResult = S.Schema.Type<typeof ModelCatalogResult>;

// settings/* (ADR-0024): the user's preferred model + global effort.

/**
 * `settings/get` / `settings/set` result: the effective model selection and global effort for the default Workflow.
 *
 * `enabled_models` is the set of catalog model ids the user has made available for chat; it is `[]` (the empty
 * "uncurated = all enabled" sentinel) when the user has not curated — Core returns `[]`, never the materialized
 * catalog, so the client expands empty→all and models added later are not frozen out for an uncurated user.
 */
export const SettingsResult = S.Struct({
	provider: S.String,
	model: S.NullOr(S.String),
	effort: S.String,
	enabled_models: S.Array(S.String),
});

export type SettingsResult = S.Schema.Type<typeof SettingsResult>;

/**
 * `settings/set` params: a partial update; an absent field is left unchanged.
 *
 * `enabled_models` replaces the curated set of catalog model ids made available in chat. An empty `[]` is the
 * "uncurated = all enabled" sentinel (a reset), always accepted; for a non-empty (curated) set Core rejects with
 * invalid_params if the effective default model is not a member.
 */
export const SettingsSetParams = S.Struct({
	model: S.optional(S.String),
	effort: S.optional(S.String),
	enabled_models: S.optional(S.Array(S.String)),
});

export type SettingsSetParams = S.Schema.Type<typeof SettingsSetParams>;
