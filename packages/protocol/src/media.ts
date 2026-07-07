// media/* wire schemas (upload) — chat image attachments (ADR-0058).

import { Schema as S } from "effect";

/** `media/upload` params (ADR-0058): the client supplies the raw bytes plus the
 * `mime` it determined and optional pixel dimensions — Core never sniffs mime
 * or extracts dimensions (the ADR-0058 scope boundary). Core computes
 * `byte_size` and the content digest itself from the decoded bytes. */
export const MediaUploadParams = S.Struct({
	bytes_base64: S.String,
	mime: S.String,
	width: S.optional(S.Number),
	height: S.optional(S.Number),
});

export type MediaUploadParams = S.Schema.Type<typeof MediaUploadParams>;

/** `media/upload` result (ADR-0058): the id of the stored media blob. */
export const MediaUploadResult = S.Struct({ media_id: S.String });

export type MediaUploadResult = S.Schema.Type<typeof MediaUploadResult>;
